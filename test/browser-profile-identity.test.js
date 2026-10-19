import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdirSync,existsSync,readFileSync,realpathSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {reopenFixture} from './helpers/browser-reopen-fixture.js';
import {chromeProcessConflicts} from '../src/browser-profile-reopen.js';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

for(const [label,dev,ino,expected] of [
 ['same entity with distinct canonical strings',101n,9007199254740992n,true],
 ['same device but different inode',101n,9007199254740993n,false],
 ['same inode but different device',102n,9007199254740992n,false],
 ['unavailable device',undefined,9007199254740992n,'PATH_UNVERIFIED'],
 ['unavailable inode',101n,undefined,'PATH_UNVERIFIED'],
 ['zero inode',101n,0n,'PATH_UNVERIFIED'],
 ['invalid device',-1n,9007199254740992n,'PATH_UNVERIFIED']
])test('directory metadata comparison: '+label,t=>{
 const scope={profile_dir:'/metadata-fixture/chrome',cdp_port:17921},alias='/metadata-fixture/CHROME';
 t.mock.method(fs,'realpathSync',path=>path);
 t.mock.method(fs,'lstatSync',(path,options)=>{assert.equal(options.bigint,true);return {isDirectory:()=>true,dev:path===scope.profile_dir?101n:dev,ino:path===scope.profile_dir?9007199254740992n:ino};});
 syncBuiltinESMExports();
 try{const call=()=>chromeProcessConflicts({command:CHROME+' --user-data-dir='+alias+' about:blank'},scope);if(typeof expected==='boolean')assert.equal(call(),expected);else assert.throws(call,/BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED/);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('case alias of existing physical directory blocks before marker/readback/preflight/spawn',async t=>{
 const f=reopenFixture(t),before=f.snapshot(),alias=f.profile.user_data_dir.replace(/chrome$/,'CHROME');
 // On case-sensitive hosts a symlink exercises the same physical-directory gate; the independent
 // Mac repro additionally requires unequal realpath strings and equal device/inode.
 if(!existsSync(alias))symlinkSync(f.profile.user_data_dir,alias);
 const a=statSync(alias,{bigint:true}),b=statSync(f.profile.user_data_dir,{bigint:true});assert.equal(a.dev,b.dev);assert.equal(a.ino,b.ino);
 const command=CHROME+' --remote-debugging-port=17922 --user-data-dir='+alias+' about:blank';
 assert.equal(chromeProcessConflicts({command},f.authorization.scope),true);
 const r=f.instance({processState:async()=>({chrome:[{pid:88,command}],listeners:[]})});
 await assert.rejects(r.start(f.w.id,f.job.id,f.input()),/^Error: BROWSER_REOPEN_PROCESS_CONFLICT$/);
 assert.equal(f.launches,0);assert.equal(f.preflights,0);assert.equal(existsSync(r.marker),false);assert.equal(existsSync(join(f.owner,'../readback')),false);assert.deepEqual(f.snapshot(),before);assert.deepEqual(readFileSync(f.owner),f.lease);
});

for(const flags of ['--remote-debugging-port=17922 about:blank','','about:blank'])test('missing directory argument fails closed: '+(flags||'plain official executable'),async t=>{
 const f=reopenFixture(t),before=f.snapshot(),command=CHROME+(flags?' '+flags:'');
 assert.throws(()=>chromeProcessConflicts({command},f.authorization.scope),/^Error: BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED$/);
 const r=f.instance({processState:async()=>({chrome:[{pid:88,command}],listeners:[]})});
 await assert.rejects(r.start(f.w.id,f.job.id,f.input()),/^Error: BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED$/);
 assert.equal(f.launches,0);assert.equal(f.preflights,0);assert.equal(existsSync(r.marker),false);assert.equal(existsSync(join(f.owner,'../readback')),false);assert.deepEqual(f.snapshot(),before);assert.deepEqual(readFileSync(f.owner),f.lease);assert.equal(r.view(f.w.id,f.job.id).state,'AVAILABLE');
});

test('verified unrelated physical directory without debugging port still permits one mock attempt',async t=>{
 const f=reopenFixture(t),before=f.snapshot(),other=join(f.root,'unrelated-chrome');mkdirSync(other);const path=realpathSync(other);
 const command=CHROME+' --user-data-dir='+path+' about:blank';assert.equal(chromeProcessConflicts({command},f.authorization.scope),false);
 const r=f.instance({processState:async scope=>{const live=await f.hooks.processState(scope);return {...live,chrome:[{pid:88,command},...live.chrome]};}});
 assert.equal((await r.start(f.w.id,f.job.id,f.input())).stage,'STARTED');assert.equal(f.launches,1);assert.equal(f.preflights,1);assert.deepEqual(f.snapshot(),before);assert.deepEqual(readFileSync(f.owner),f.lease);
});

test('non-directory metadata and missing frozen scope path cannot prove independence',t=>{
 const f=reopenFixture(t),file=join(f.root,'not-a-directory');writeFileSync(file,'disposable fixture only');
 assert.throws(()=>chromeProcessConflicts({command:CHROME+' --user-data-dir='+file},f.authorization.scope),/BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED/);
 const other=join(f.root,'unrelated-chrome');mkdirSync(other);
 assert.throws(()=>chromeProcessConflicts({command:CHROME+' --user-data-dir='+other},{...f.authorization.scope,profile_dir:join(f.root,'missing-frozen-directory')}),/BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED/);
});
