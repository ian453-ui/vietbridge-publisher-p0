import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,symlinkSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserResources} from '../src/browser-resources.js';
function setup(t){const root=mkdtempSync(join(tmpdir(),'vb-browser-resources-')),locks=join(root,'locks'),profile=join(root,'chrome');mkdirSync(profile);t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,locks,profile,first:new BrowserResources(locks),second:new BrowserResources(locks)};}
test('independent module guards exclude the same physical browser, including symlink aliases',t=>{
 const f=setup(t),alias=join(f.root,'alias');symlinkSync(f.profile,alias);
 const release=f.first.acquire(f.profile,'publisher:j',()=>false);
 assert.throws(()=>f.second.acquire(alias,'operator:p',()=>false),/BROWSER_RECONCILIATION_REQUIRED/);
 release();f.second.acquire(alias,'operator:p',()=>false)();assert.equal(readdirSync(f.locks).length,0);
});
test('unknown results survive restart and only the same owner can reconcile without resubmission',t=>{
 const f=setup(t);let unknown=true;
 f.first.acquire(f.profile,'publisher:j',()=>unknown)();
 const restarted=new BrowserResources(f.locks);
 assert.throws(()=>restarted.acquire(f.profile,'publisher:j',()=>unknown),/BROWSER_RECONCILIATION_REQUIRED/);
 assert.throws(()=>restarted.acquire(f.profile,'operator:p',()=>unknown,{reconcile:true}),/BROWSER_RECONCILIATION_REQUIRED/);
 const readback=restarted.acquire(f.profile,'publisher:j',()=>unknown,{reconcile:true});
 assert.throws(()=>f.second.acquire(f.profile,'publisher:j',()=>unknown,{reconcile:true}),/BROWSER_RESOURCE_BUSY/);
 readback();assert.equal(readdirSync(f.locks).length,1);
 const confirmed=restarted.acquire(f.profile,'publisher:j',()=>unknown,{reconcile:true});unknown=false;confirmed();
 assert.equal(readdirSync(f.locks).length,0);
});
test('a dead ACTIVE owner remains blocked for writes and admits only explicit readback',t=>{
 const f=setup(t);f.first.acquire(f.profile,'publisher:crashed',()=>true);
 const file=join(f.locks,readdirSync(f.locks)[0],'owner.json'),record=JSON.parse(readFileSync(file));
 writeFileSync(file,JSON.stringify({...record,pid:2147483647}));
 assert.throws(()=>f.second.acquire(f.profile,'publisher:crashed',()=>false),/BROWSER_RECONCILIATION_REQUIRED/);
 f.second.acquire(f.profile,'publisher:crashed',()=>false,{reconcile:true})();
});
test('different profiles are concurrent; stale tokens cannot release a replaced lease',t=>{
 const f=setup(t),release=f.first.acquire(f.profile,'publisher:j',()=>false);
 const other=f.second.acquire(join(f.root,'another-chrome'),'operator:q',()=>false);other();
 const file=join(f.locks,readdirSync(f.locks)[0],'owner.json'),record=JSON.parse(readFileSync(file));writeFileSync(file,JSON.stringify({...record,token:'replacement'}));
 assert.throws(release,/BROWSER_STALE_LEASE/);assert.equal(readdirSync(f.locks).length,1);
});
