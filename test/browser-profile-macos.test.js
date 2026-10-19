import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,statSync,realpathSync,existsSync,readFileSync,writeFileSync,symlinkSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {reopenFixture} from './helpers/browser-reopen-fixture.js';
import {reopenProcessState,chromeProcessConflicts} from '../src/browser-profile-reopen.js';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function processReader(command){return async(file,args)=>{
 if(file==='/bin/ps')return {stdout:args.includes('pid=,comm=')?'1257 '+CHROME+'\n':command+'\n'};
 assert.equal(file,'/usr/sbin/lsof','no native default-root inference or browser command');return {stdout:''};
};}
for(const kind of ['ordinary-default-with-only-metadata','two-roots-share-live-endpoint','historical-redirect-with-copied-links','default-root-moved-after-start'])test('unproven root role refuses before marker/readback/spawn: '+kind,async t=>{
 const f=reopenFixture(t),before=f.snapshot(),defaultRoot=join(f.root,'ordinary-default');mkdirSync(defaultRoot);
 const endpoint=join(f.root,'private-socket','SingletonSocket');mkdirSync(join(f.root,'private-socket'),{mode:0o700});writeFileSync(endpoint,'mock endpoint only');
 if(kind!=='ordinary-default-with-only-metadata')for(const root of [defaultRoot,f.profile.user_data_dir]){symlinkSync('mock-host-1257',join(root,'SingletonLock'));symlinkSync(endpoint,join(root,'SingletonSocket'));}
 if(kind==='default-root-moved-after-start'){renameSync(defaultRoot,defaultRoot+'-old');mkdirSync(defaultRoot);for(const name of ['SingletonLock','SingletonSocket'])symlinkSync(name==='SingletonLock'?'mock-host-1257':endpoint,join(defaultRoot,name));}
 const path=realpathSync(defaultRoot),st=statSync(path,{bigint:true}),frozen=statSync(f.profile.user_data_dir,{bigint:true});assert.notEqual(st.ino,frozen.ino);
 const allegedProof={pid:1257,command:CHROME,uid:process.getuid(),path,dev:String(st.dev),ino:String(st.ino),startTime:'1700000000:123456',socketOwnedByPid:true,policyAbsent:true};
 const r=f.instance({processState:async s=>{const v=await reopenProcessState(s,{run:processReader(CHROME)});Object.assign(v.chrome[0],{nativeProof:allegedProof,verifiedDefaultDirectory:path,...allegedProof});return v;}});
 await assert.rejects(r.start(f.w.id,f.job.id,f.input()),/^Error: BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED$/);
 assert.equal(f.launches,0);assert.equal(f.preflights,0);assert.equal(existsSync(r.marker),false);assert.equal(existsSync(join(f.owner,'../readback')),false);assert.deepEqual(f.snapshot(),before);assert.deepEqual(readFileSync(f.owner),f.lease);assert.equal(r.view(f.w.id,f.job.id).state,'AVAILABLE');
});
test('plain missing-flag process metadata never invokes a default-root native collector',async t=>{
 const f=reopenFixture(t),v=await reopenProcessState(f.authorization.scope,{run:processReader(CHROME)});assert.deepEqual(v.chrome,[{pid:1257,command:CHROME}]);assert.throws(()=>chromeProcessConflicts(v.chrome[0],f.authorization.scope),/PATH_UNVERIFIED/);
});
test('normal Chrome with explicit verified independent default directory remains one-attempt positive',async t=>{
 const f=reopenFixture(t),before=f.snapshot(),path=join(f.root,'ordinary-default');mkdirSync(path);const command=CHROME+' --user-data-dir='+realpathSync(path);let reads=0;
 const r=f.instance({processState:s=>++reads===1?reopenProcessState(s,{run:processReader(command)}):f.hooks.processState(s)});
 assert.equal((await r.start(f.w.id,f.job.id,f.input())).stage,'STARTED');assert.equal(f.launches,1);assert.equal(f.preflights,1);assert.deepEqual(f.snapshot(),before);assert.deepEqual(readFileSync(f.owner),f.lease);
 await assert.rejects(f.instance().start(f.w.id,f.job.id,f.input()),/ALREADY_ATTEMPTED/);
 const a={...f.authorization,id:'changed-id-same-user-approval'};await assert.rejects(f.instance({},a).start(f.w.id,f.job.id,{...f.input(),authorization_id:a.id}),/ALREADY_ATTEMPTED/);assert.equal(f.launches,1);
});
test('client-supplied root proof cannot extend exact authorized reopen input',async t=>{
 const f=reopenFixture(t),r=f.instance();await assert.rejects(r.start(f.w.id,f.job.id,{...f.input(),verifiedDefaultDirectory:'/fake',rootBinding:true}),/EXACT_CONFIRMATION_REQUIRED/);assert.equal(f.launches,0);assert.equal(existsSync(r.marker),false);
});
