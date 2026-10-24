import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {fileBucket} from './fixtures/sites-evidence.js';
import {createCloudAuthoringApi} from '../src/sites/cloud-authoring-api.js';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'sites-real-')),f=cloudD1Fixture(join(root,'db.sqlite')),bucket=fileBucket(join(root,'r2'));
 t.after(()=>{f.close();rmSync(root,{recursive:true,force:true});});
 return {f,bucket};
}
async function seed(f){
 const workspace=(await f.call('/api/sites/workspaces',{command_id:crypto.randomUUID(),name:'Synthetic LP'})).body.id;
 const base='/api/sites/workspaces/'+workspace;
 const account=(await f.call(base+'/accounts',{command_id:crypto.randomUUID(),display_name:'Synthetic Page',platform:'facebook',external_identity:null})).body.id;
 f.sql.prepare('UPDATE sites_account_details SET external_identity=? WHERE workspace=? AND account_id=?').run('61594159443807',workspace,account);
 const content=(await f.call(base+'/contents',{command_id:crypto.randomUUID(),account_id:account,content_id:'SYNTHETIC-LP-011',slug:'synthetic-materials',revision:1,title:'Source title',body:'Source body',variants:{facebook:{title:'Platform title',body:'Platform body'}}})).body.id;
 return {workspace,account,base,content,path:base+'/real-contents/'+content+'?accountId='+account};
}
function api(f,bucket,relay,user=()=> 'synthetic-owner'){
 const handler=createCloudAuthoringApi({db:f.db,bucket,relayClient:relay,origin:f.origin,getTrustedIdentity:async()=>user()?{userId:user()}:null});
 return async(path,{method='GET',body=null,headers={}}={})=>{
  const request=new Request(f.origin+path,{method,headers:{...(method==='POST'?{origin:f.origin}:{}),...(body instanceof Uint8Array?{'Content-Type':'image/png','X-Content-Sha256':createHash('sha256').update(body).digest('hex')}:{'Content-Type':'application/json'}),...headers},...(body===null?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});
  const response=await handler(request);return {status:response.status,body:response.headers.get('content-type')?.startsWith('image/')?new Uint8Array(await response.arrayBuffer()):await response.json()};
 };
}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic pixels')]);
const checks={text_checked:true,facts_checked:true,visual_checked:true,account_checked:true,platform_checked:true};

test('real Site owner upload, manual QA, exact freeze and Mac readback stay separate from synthetic records',async t=>{
 const {f,bucket}=setup(t),s=await seed(f),job='5ee5f131-338e-4d65-bc34-1e34dc4c9a80',localHash='a'.repeat(64);
 let sent=0,uploads=0,allowed=false,remoteState='READY';
 const relay={async upload(id,ordinal,meta){uploads++;assert.equal(id,job);assert.equal(ordinal,0);assert.equal(meta.sha256,createHash('sha256').update(png).digest('hex'));return {site_job_id:id,ordinal,...meta};},async prepare(id,input){assert.equal(id,job);assert.equal(input.site_account_id,s.account);return {site_job_id:id,site_workspace_id:s.workspace,site_account_id:s.account,site_snapshot_hash:input.site_snapshot_hash,local_job_id:'39786221-4438-4b94-8651-ff31f6049113',local_snapshot_hash:localHash,state:'READY',verified:false};},async capability(id){return {site_job_id:id,site_snapshot_hash:freeze.body.site_snapshot_hash,local_snapshot_hash:localHash,capability:{canExecute:allowed}};},async dispatch(){sent++;remoteState='UNKNOWN';return {state:'UNKNOWN'};},async status(id){return {site_job_id:id,site_workspace_id:s.workspace,site_account_id:s.account,site_snapshot_hash:freeze.body.site_snapshot_hash,local_job_id:'39786221-4438-4b94-8651-ff31f6049113',local_snapshot_hash:localHash,state:remoteState,verified:remoteState==='PUBLISHED',evidence_origin:remoteState==='PUBLISHED'?'MAC_UNIFIED_EXECUTOR_READBACK':null};}};
 const call=api(f,bucket,relay),mediaPath=s.base+'/real-contents/'+s.content+'/media/0?accountId='+s.account;
 assert.equal((await call(s.path)).body.review,null);
 assert.equal((await call(mediaPath,{method:'POST',body:png})).status,200);
 assert.equal((await call(mediaPath,{method:'POST',body:png})).body.duplicate,true);
 assert.equal((await call(mediaPath,{method:'POST',body:Buffer.concat([png,Buffer.from('different')])})).body.error,'REAL_MEDIA_CONFLICT');
 const preview=(await call(s.path)).body;assert.equal(preview.media.length,1);
 assert.equal((await call(s.base+'/real-contents/'+s.content+'/freeze?accountId='+s.account,{method:'POST',body:{site_job_id:job,expected_snapshot_hash:preview.snapshot_hash,confirm:true}})).body.error,'REAL_FREEZE_NOT_REVIEWED');
 assert.equal((await call(s.base+'/real-contents/'+s.content+'/review?accountId='+s.account,{method:'POST',body:{expected_snapshot_hash:preview.snapshot_hash,source_refs:['https://example.test/source'],checks:{...checks,facts_checked:false}}})).body.error,'REAL_REVIEW_INCOMPLETE');
 const review=(await call(s.base+'/real-contents/'+s.content+'/review?accountId='+s.account,{method:'POST',body:{expected_snapshot_hash:preview.snapshot_hash,source_refs:['https://example.test/source'],checks}})).body;
 assert.equal(review.state,'OWNER_REVIEWED');
 const freeze=await call(s.base+'/real-contents/'+s.content+'/freeze?accountId='+s.account,{method:'POST',body:{site_job_id:job,expected_snapshot_hash:preview.snapshot_hash,confirm:true}});
 assert.equal(freeze.status,200,JSON.stringify(freeze.body));assert.equal(freeze.body.state,'FROZEN');
 const frozen=f.sql.prepare('SELECT manifest_hash,snapshot_json FROM sites_real_jobs WHERE job_id=?').get(job),snapshot=JSON.parse(frozen.snapshot_json);
 assert.equal(frozen.manifest_hash,createHash('sha256').update(JSON.stringify({platform:snapshot.platform,external_identity:snapshot.external_identity,title:snapshot.title,body:snapshot.body,payload:snapshot.payload,media:snapshot.media})).digest('hex'));
 f.sql.prepare('UPDATE sites_account_details SET external_identity=? WHERE account_id=?').run('changed-identity',s.account);
 assert.equal((await call(s.base+'/real-jobs/'+job+'/prepare?accountId='+s.account,{method:'POST',body:{command_id:crypto.randomUUID()}})).body.error,'REAL_JOB_CHANGED');
 assert.equal(uploads,0);
 f.sql.prepare('UPDATE sites_account_details SET external_identity=? WHERE account_id=?').run('61594159443807',s.account);
 assert.equal((await call(s.base+'/real-jobs/'+job+'/prepare?accountId='+s.account,{method:'POST',body:{command_id:crypto.randomUUID()}})).status,200);
 assert.equal(uploads,1);
 const submitPath=s.base+'/real-jobs/'+job+'/dispatch?accountId='+s.account,submit={confirm:true,site_snapshot_hash:freeze.body.site_snapshot_hash,local_snapshot_hash:localHash,command_id:crypto.randomUUID()};
 assert.equal((await call(submitPath,{method:'POST',body:submit})).body.error,'REAL_LOCAL_EXECUTION_UNAVAILABLE');assert.equal(sent,0);
 allowed=true;const result=await call(submitPath,{method:'POST',body:submit});assert.equal(result.body.state,'UNKNOWN');assert.equal(sent,1);
 assert.equal((await call(submitPath,{method:'POST',body:submit})).body.error,'REAL_SUBMIT_UNAVAILABLE');assert.equal(sent,1);
 remoteState='PUBLISHED';const published=await call(s.base+'/real-jobs/'+job+'/refresh?accountId='+s.account,{method:'POST',body:{}});assert.equal(published.body.verified,true);assert.equal(sent,1);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,0);
});

test('real media and review require official owner scope, R2, origin and exact bytes',async t=>{
 const {f,bucket}=setup(t),s=await seed(f);let user='synthetic-owner';const call=api(f,bucket,null,()=>user),mediaPath=s.base+'/real-contents/'+s.content+'/media/0?accountId='+s.account;
 assert.equal((await call(mediaPath,{method:'POST',body:png,headers:{origin:'https://evil.invalid'}})).status,403);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_real_media').get().n,0);
 user='another-user';assert.equal((await call(s.path)).status,403);user=null;assert.equal((await call(s.path)).status,401);user='synthetic-owner';
 assert.equal((await call(mediaPath,{method:'POST',body:Buffer.from('not an image')})).body.error,'REAL_MEDIA_INVALID');
 assert.equal((await call(mediaPath,{method:'POST',body:png})).status,200);
 const preview=(await call(s.path)).body;assert.equal(preview.review,null);
 assert.equal((await call(s.base+'/real-contents/'+s.content+'/review?accountId='+s.account,{method:'POST',body:{expected_snapshot_hash:'0'.repeat(64),source_refs:['https://example.test/source'],checks}})).body.error,'REAL_REVIEW_INCOMPLETE');
 assert.equal((await call(s.base+'/real-jobs/'+crypto.randomUUID()+'?accountId='+s.account)).status,404);
});

test('uncertain or unapproved preparation keeps one intent and resumes only its original command after status reconciliation',async t=>{
 const {f,bucket}=setup(t),s=await seed(f),job=crypto.randomUUID(),command=crypto.randomUUID();
 let approved=false,bound=false,prepares=0,uploads=0;
 const relay={async upload(){uploads++;return {};},async status(){if(!bound)throw Error('V3_BINDING_NOT_FOUND');return {site_job_id:job,site_workspace_id:s.workspace,site_account_id:s.account,site_snapshot_hash:f.sql.prepare('SELECT site_snapshot_hash FROM sites_real_jobs WHERE job_id=?').get(job).site_snapshot_hash,local_job_id:crypto.randomUUID(),local_snapshot_hash:'a'.repeat(64),state:'READY',verified:false};},async prepare(id,input){prepares++;if(!approved)throw Error('V3_TASK_APPROVAL_REQUIRED');bound=true;return this.status(id);}};
 const call=api(f,bucket,relay),base=s.base+'/real-contents/'+s.content+'?accountId='+s.account;
 await call(s.base+'/real-contents/'+s.content+'/media/0?accountId='+s.account,{method:'POST',body:png});
 const preview=(await call(base)).body;
 await call(s.base+'/real-contents/'+s.content+'/review?accountId='+s.account,{method:'POST',body:{expected_snapshot_hash:preview.snapshot_hash,source_refs:['https://example.test/source'],checks}});
 assert.equal((await call(s.base+'/real-contents/'+s.content+'/freeze?accountId='+s.account,{method:'POST',body:{site_job_id:job,expected_snapshot_hash:preview.snapshot_hash,confirm:true}})).status,200);
 const preparePath=s.base+'/real-jobs/'+job+'/prepare?accountId='+s.account,refreshPath=s.base+'/real-jobs/'+job+'/refresh?accountId='+s.account;
 assert.equal((await call(preparePath,{method:'POST',body:{command_id:command}})).body.error,'V3_TASK_APPROVAL_REQUIRED');
 assert.equal(f.sql.prepare('SELECT state FROM sites_real_jobs WHERE job_id=?').get(job).state,'PREPARE_INTENT');
 assert.equal((await call(refreshPath,{method:'POST',body:{}})).body.state,'PREPARE_INTENT');
 assert.equal((await call(preparePath,{method:'POST',body:{command_id:crypto.randomUUID()}})).body.error,'REAL_PREPARE_UNAVAILABLE');
 approved=true;const resumed=await call(preparePath,{method:'POST',body:{command_id:command}});assert.equal(resumed.body.state,'PREPARED');
 assert.equal(prepares,2);assert.equal(uploads,2);
 assert.equal((await call(preparePath,{method:'POST',body:{command_id:command}})).body.error,'REAL_PREPARE_UNAVAILABLE');
});
