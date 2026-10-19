import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,realpathSync,rmSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {setup} from './helpers/scoped-fixture.js';
import {cloudFor} from './helpers/scoped-wrapper-fixture.js';
import {createApp} from '../src/server.js';
import {createControlledApp} from '../maintenance/controlled-app.mjs';
import {executionScope} from '../src/single-execution-permit.js';
import {PublisherAccess} from '../src/publisher-access.js';

async function fixture(t,{configured=true}={}){
 const f=setup(t),job=f.makePage('Complete approved fixture caption',true);
 f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='retained-attempt' WHERE id=?").run(job.id);
 mkdirSync(job.snapshot.profileDir,{recursive:true});f.executor.acquireResources(job.snapshot)();
 const lease=join(f.executor.resources.directory,createHash('sha256').update(realpathSync(job.snapshot.profileDir)).digest('hex'),'owner.json'),scope=executionScope(job),cloud=cloudFor(f);
 let creates=0,observations=0,wait,closeError=false;
 const drivers={create:async snapshot=>{creates++;assert.equal(snapshot.profileDir,job.snapshot.profileDir);assert.equal(snapshot.cdpPort,job.snapshot.cdpPort);return {diagnose:async()=>{observations++;if(wait)await wait;return {conclusion:'INCOMPLETE',absenceProven:false};},closeDiagnostic:async()=>{if(closeError)throw Error('MOCK_DISCONNECT_FAILED');},prepare(){throw Error('FORBIDDEN_PREPARE');},submit(){throw Error('FORBIDDEN_SUBMIT');},readback(){throw Error('FORBIDDEN_HISTORY_RECONCILE');}};}};
 const config={version:1,mode:'READ_ONLY',...(configured?{diagnostic:scope}:{})};
 // An option cannot smuggle authority past an empty controlled configuration.
 const server=createControlledApp(createApp,f.dbPath,{config,head:'b'.repeat(40),cloud,resources:f.executor.resources,readOnlyDiagnosticScope:scope,drivers,library:{roots:[f.root],gptInboxBase:null}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.once('storage-closed',resolve);server.close();}));
 const origin='http://127.0.0.1:'+server.address().port,login=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cloud.user,password:cloud.password}),redirect:'manual'});assert.equal(login.status,303);
 const cookie=login.headers.get('set-cookie').split(';')[0],state=await(await fetch(origin+'/api/state?workspace='+f.w.id,{headers:{cookie}})).json();
 const get=(path,extra={})=>fetch(origin+path,{headers:{cookie,...extra}}),post=(path,input={},extra={})=>fetch(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-local-token':state.token,...extra},body:JSON.stringify(input)}),base='/api/unified/workspaces/'+f.w.id+'/jobs',path=base+'/'+job.id+'/diagnostics';
 const capability=async()=>{const result=await(await get(base)).json();return result.jobs.find(j=>j.id===job.id).readOnlyDiagnostic;};
 const history=()=>JSON.stringify(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('publisher_diagnostic_runs','publisher_composer_observations') ORDER BY name").all().map(({name})=>[name,f.store.db.prepare('SELECT * FROM "'+name+'"').all()]));
 return {...f,job,scope,cloud,lease,base,path,origin,cookie,token:state.token,get,post,capability,history,get creates(){return creates;},get observations(){return observations;},set wait(value){wait=value;},set closeError(value){closeError=value;}};
}

test('configured exact UNKNOWN capability reads without work, then one explicit diagnostic preserves all history and pending owner bytes',async t=>{
 const f=await fixture(t),before=f.history(),lease=readFileSync(f.lease),cap=await f.capability();assert.equal(cap.canStart,true);assert.deepEqual(cap.scope,f.scope);assert.equal(f.creates,0);assert.equal(f.history(),before);
 assert.equal((await f.post(f.path,{snapshot_hash:f.job.snapshot_hash})).status,202);const run=await(await f.get(f.path)).json();assert.equal(run.state,'DONE');assert.equal(run.result.absenceProven,false);assert.equal(f.creates,1);assert.equal(f.observations,1);assert.equal(f.history(),before);assert.deepEqual(readFileSync(f.lease),lease);assert.equal(existsSync(join(dirname(f.lease),'readback')),false);
 for(const action of ['reconcile','composer-observation','execute','execution-permit','resolve-preparation','finish-unpublished','manual-complete','reopen'])assert.equal((await f.post(f.base+'/'+f.job.id+'/'+action,{snapshot_hash:f.job.snapshot_hash,confirm:true})).status,423,action);
 const health=await(await f.get('/api/health')).json();assert.equal(health.executionEnabled,false);assert.equal(health.scanSchedulerEnabled,false);assert.equal(f.history(),before);
});

test('empty maintenance config ignores injected capability option and keeps diagnostic POST blocked while old GET records remain readable',async t=>{
 const f=await fixture(t,{configured:false}),before=f.history();assert.equal(await f.capability(),undefined);assert.equal((await f.get(f.path)).status,200);assert.equal((await f.post(f.path,{snapshot_hash:f.job.snapshot_hash})).status,423);assert.equal(f.creates,0);assert.equal(f.history(),before);
});

test('normal auth, Host, Origin, CSRF, exact input, query and another job guard before any browser driver',async t=>{
 const f=await fixture(t),before=f.history(),input={snapshot_hash:f.job.snapshot_hash};
 for(const [extra,status] of [[{cookie:''},401],[{'x-local-token':''},409],[{origin:'https://wrong.invalid'},409]])assert.equal((await f.post(f.path,input,extra)).status,status);
 const hostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(f.origin+f.path,{method:'POST',headers:{host:'wrong.invalid',cookie:f.cookie,origin:f.origin,'x-local-token':f.token,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(input));});assert.equal(hostStatus,409);
 for(const value of [{snapshot_hash:'0'.repeat(64)},{...input,execute:true},{...input,scope:f.scope}])assert.equal((await f.post(f.path,value)).status,409);
 assert.equal((await f.post(f.path+'?workspace=ws-other',input)).status,409);assert.equal((await f.post(f.path.replace(f.job.id,'00000000-0000-0000-0000-000000000000'),input)).status,423);
 const access=new PublisherAccess(f.cloud),app=access.createToken({name:'mock-read-app',password:f.cloud.password,workspaces:[f.w.id],scopes:['jobs:read','jobs:create'],days:1});
 assert.equal((await f.post(f.path,input,{authorization:'Bearer '+app.token})).status,403);const list=await(await f.get(f.base,{authorization:'Bearer '+app.token})).json();assert.equal(list.jobs[0].readOnlyDiagnostic.canStart,false);
 assert.equal(f.creates,0);assert.equal(f.observations,0);
 // Token creation is fixture administration; diagnostic attempts never touch job/history.
 assert.deepEqual({...f.store.db.prepare('SELECT state,snapshot_hash,attempt_id FROM publisher_jobs WHERE id=?').get(f.job.id)},{state:'UNKNOWN',snapshot_hash:f.job.snapshot_hash,attempt_id:'retained-attempt'});assert.equal(f.history(),before);
});

test('missing, ACTIVE, foreign or readback-busy original pending lease blocks capability and driver without creating another owner',async t=>{
 const f=await fixture(t),before=f.history(),bytes=readFileSync(f.lease),old=JSON.parse(bytes),input={snapshot_hash:f.job.snapshot_hash};
 for(const patch of [{phase:'ACTIVE'},{owner:'operator:another-profile'},{resource:old.resource+'-wrong'}]){writeFileSync(f.lease,JSON.stringify({...old,...patch}));const changed=readFileSync(f.lease);assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);assert.deepEqual(readFileSync(f.lease),changed);}
 writeFileSync(f.lease,bytes);mkdirSync(join(dirname(f.lease),'readback'));assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);rmSync(join(dirname(f.lease),'readback'),{recursive:true});
 rmSync(dirname(f.lease),{recursive:true});assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);assert.equal(existsSync(dirname(f.lease)),false);assert.equal(f.creates,0);assert.equal(f.history(),before);
});

test('changed account/profile mapping, content, frozen task state or hash revokes displayed ability before connection',async t=>{
 const f=await fixture(t),input={snapshot_hash:f.job.snapshot_hash};
 for(const [table,key,value,id] of [['execution_profiles','cdp_port',17922,f.profile.id],['execution_profiles','user_data_dir',f.job.snapshot.profileDir+'-different',f.profile.id],['facebook_accounts','operator_actor_id','999999999999',f.account.id]]){
  const old=f.store.db.prepare('SELECT '+key+' value FROM '+table+' WHERE id=?').get(id).value;f.store.db.prepare('UPDATE '+table+' SET '+key+'=? WHERE id=?').run(value,id);assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);f.store.db.prepare('UPDATE '+table+' SET '+key+'=? WHERE id=?').run(old,id);
 }
 const body=f.store.db.prepare('SELECT body FROM group_content WHERE id=?').get(f.job.content_id).body;f.store.db.prepare('UPDATE group_content SET body=? WHERE id=?').run('changed caption',f.job.content_id);assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);f.store.db.prepare('UPDATE group_content SET body=? WHERE id=?').run(body,f.job.content_id);
 f.store.db.prepare("UPDATE publisher_jobs SET state='CANCELLED' WHERE id=?").run(f.job.id);assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',snapshot_hash=? WHERE id=?").run('0'.repeat(64),f.job.id);assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);assert.equal(f.creates,0);
});

test('same original owner permits one in-flight run and cleanup failure retains readback exclusion',async t=>{
 const f=await fixture(t),before=f.history(),bytes=readFileSync(f.lease);let release;f.wait=new Promise(resolve=>release=resolve);const input={snapshot_hash:f.job.snapshot_hash};
 assert.equal((await f.post(f.path,input)).status,202);assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);assert.equal(f.creates,1);assert.deepEqual(readFileSync(f.lease),bytes);release();
 for(let i=0;i<20;i++){if((await(await f.get(f.path)).json()).state==='DONE')break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal((await f.capability()).canStart,true);f.wait=null;f.closeError=true;assert.equal((await f.post(f.path,input)).status,202);const done=await(await f.get(f.path)).json();assert.equal(done.result.leaseRetained,true);assert.equal((await f.capability()).canStart,false);assert.equal((await f.post(f.path,input)).status,409);assert.equal(f.creates,2);assert.deepEqual(readFileSync(f.lease),bytes);assert.equal(existsSync(join(dirname(f.lease),'readback')),true);assert.equal(f.history(),before);
});
