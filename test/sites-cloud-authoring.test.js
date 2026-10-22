import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {createCloudAuthoringApi,cloudDigest} from '../src/sites/cloud-authoring-api.js';

function setup(t){const root=mkdtempSync(join(tmpdir(),'v3-sites-authoring-')),path=join(root,'cloud.sqlite'),f=cloudD1Fixture(path);t.after(()=>{f.close();rmSync(root,{recursive:true,force:true});});return {...f,path,fixture:f};}
async function seed(f){const w=(await f.call('/api/sites/workspaces',{command_id:crypto.randomUUID(),name:'Synthetic Cloud Customer'})).body.id,base='/api/sites/workspaces/'+w,a=(await f.call(base+'/accounts',{command_id:crypto.randomUUID(),display_name:'Synthetic Facebook',platform:'facebook',external_identity:null})).body.id;assert.ok(w);assert.ok(a);return {w,a,base};}
const content=(a,overrides={})=>({command_id:crypto.randomUUID(),account_id:a,content_id:'STUDY-20261022-074',slug:'study-options',revision:1,title:'Synthetic complete title',body:'Complete original body\nSecond paragraph retained.',variants:{facebook:{title:'Facebook variant',body:'Explicit Facebook body\nComplete ending.'}},...overrides});
test('persisted cloud authoring uses original source/job projections, full content and independent platform payload; restart retains all records',async t=>{
 const f=setup(t),{w,a,base}=await seed(f),input=content(a),saved=await f.call(base+'/contents',input);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.publish_allowed,false);const listed=await f.call(base+'/contents?accountId='+a);assert.equal(listed.body.contents[0].body,input.body);assert.equal(listed.body.contents[0].variants.facebook.body,input.variants.facebook.body);
 const command={command_id:crypto.randomUUID(),account_id:a,content_id:saved.body.id,expected_payload_hash:saved.body.payload_hash},task=await f.call(base+'/tasks',command);assert.equal(task.status,200);assert.equal(task.body.state,'DRAFT');assert.equal((await f.call(base+'/tasks',command)).body.id,task.body.id);assert.equal(f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);
 const original=await f.call('/api/unified/workspaces/'+w+'/jobs?accountId='+a);assert.equal(original.body.jobs[0].id,task.body.id);assert.equal(original.body.executionEnabled,false);
 const reopened=cloudD1Fixture(f.path,{initialize:false});try{const tasks=(await reopened.call(base+'/tasks?accountId='+a)).body.tasks;assert.equal(tasks[0].snapshot.payload.body,input.variants.facebook.body);assert.equal(tasks[0].snapshot_hash,await cloudDigest(tasks[0].snapshot));assert.equal((await reopened.call('/api/sites/workspaces')).body.workspaces[0].id,w);}finally{reopened.close();}
});
test('stable user identity and exact customer/account scope reject forged headers, cross-user and same-customer account mixing',async t=>{
 const f=setup(t),{w,a,base}=await seed(f),input=content(a),saved=(await f.call(base+'/contents',input)).body,other=(await f.call(base+'/accounts',{command_id:crypto.randomUUID(),display_name:'Second account',platform:'xiaohongshu',external_identity:'synthetic-only'})).body.id;
 assert.equal((await f.call(base+'/contents?accountId='+other)).body.contents.length,0);assert.equal((await f.call(base+'/tasks',{command_id:crypto.randomUUID(),account_id:other,content_id:saved.id,expected_payload_hash:saved.payload_hash})).status,404);
 f.fixture.user=null;assert.equal((await f.call('/api/sites/workspaces',null,{headers:{'oai-authenticated-user-id':'synthetic-owner'}})).status,401);f.fixture.user='different-synthetic-user';assert.deepEqual((await f.call('/api/sites/workspaces')).body.workspaces,[]);assert.equal((await f.call(base+'/contents?accountId='+a)).status,403);assert.equal((await f.call(base+'/contents',input)).status,403);
 f.fixture.user='synthetic-owner';f.sql.prepare("UPDATE sites_project_memberships SET revoked_at='2026-10-22' WHERE workspace=? AND account_id=?").run(w,a);assert.equal((await f.call(base+'/contents?accountId='+a)).status,403);assert.equal((await f.call(base+'/contents',input)).status,403);assert.equal((await f.call(base+'/accounts')).body.accounts.length,1);
});
test('full ID + slug + version + payload preserve reused 074 across dates and reject conflicting same version',async t=>{
 const f=setup(t),{a,base}=await seed(f),one=content(a),two=content(a,{content_id:'TRADE-20261021-074',slug:'trade-rules',body:'Different trade body'}),three=content(a,{slug:'different-source',body:'Different full source with same content ID'});
 for(const input of [one,two,three])assert.equal((await f.call(base+'/contents',input)).status,200);
 const same=await f.call(base+'/contents',one);assert.equal(same.body.duplicate,true);assert.equal((await f.call(base+'/contents',{...one,command_id:crypto.randomUUID(),body:'Replaced body'})).body.error,'CONTENT_VERSION_CONFLICT');assert.equal((await f.call(base+'/contents',{...one,content_id:'074'})).status,400);
 assert.equal((await f.call(base+'/contents?accountId='+a)).body.contents.length,3);assert.equal(f.sql.prepare('SELECT count(*) n FROM publisher_content_sources').get().n,3);
 assert.equal((await f.call(base+'/contents',{...two,command_id:one.command_id})).body.error,'COMMAND_CONFLICT');
});
test('single atomic batch rolls back command, account and membership on a later insertion fault',async t=>{
 const f=setup(t),{base}=await seed(f),input={command_id:crypto.randomUUID(),display_name:'Rollback account',platform:'facebook',external_identity:null};f.fixture.fault=3;
 assert.equal((await f.call(base+'/accounts',input)).body.error,'STORAGE_WRITE_REJECTED');assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_account_details').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) n FROM facebook_accounts').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_project_memberships').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_authoring_commands WHERE command_id=?').get(input.command_id).n,0);
 f.fixture.fault=-1;assert.equal((await f.call(base+'/accounts',input)).status,200);assert.equal((await f.call(base+'/accounts',input)).body.duplicate,true);
});
test('two SQLite connections using asynchronous D1 shape converge on the same command and one frozen task',async t=>{
 const f=setup(t),{a,base}=await seed(f),input=content(a),other=cloudD1Fixture(f.path,{initialize:false});try{
 const results=await Promise.all([f.call(base+'/contents',input),other.call(base+'/contents',input)]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(results[0].body.id,results[1].body.id);const c=(await f.call(base+'/contents?accountId='+a)).body.contents[0],task={command_id:crypto.randomUUID(),account_id:a,content_id:c.id,expected_payload_hash:c.payload_hash};const jobs=await Promise.all([f.call(base+'/tasks',task),other.call(base+'/tasks',task)]);assert.ok(jobs.every(r=>r.status===200),JSON.stringify(jobs));assert.equal(jobs[0].body.id,jobs[1].body.id);assert.equal(f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);
 }finally{other.close();}
});
test('UNKNOWN and exact frozen revision never reset on duplicate create; every approval/publish/media/interaction path is unavailable',async t=>{
 const f=setup(t),{w,a,base}=await seed(f),c=(await f.call(base+'/contents',content(a))).body,command={command_id:crypto.randomUUID(),account_id:a,content_id:c.id,expected_payload_hash:c.payload_hash},job=(await f.call(base+'/tasks',command)).body;
 f.sql.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='synthetic-original-attempt' WHERE id=?").run(job.id);const repeat=await f.call(base+'/tasks',{...command,command_id:crypto.randomUUID()});assert.equal(repeat.body.id,job.id);assert.equal(repeat.body.state,'UNKNOWN');
 for(const operation of ['approve','publish','upload','reconcile','reply','delete','credentials','verify-source'])assert.ok((await f.call(base+'/'+operation,{authenticated:true,approved:true})).status>=400);
 assert.equal((await f.call('/api/unified/workspaces/'+w+'/jobs/'+job.id+'/execute',{})).status,405);assert.equal(f.sql.prepare('SELECT state,attempt_id FROM publisher_jobs WHERE id=?').get(job.id).attempt_id,'synthetic-original-attempt');assert.equal(f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);
 assert.equal((await f.call(base+'/tasks',{...command,expected_payload_hash:'0'.repeat(64)})).body.error,'CONTENT_CHANGED');
});
test('Origin, body bounds, exact fields and missing identity/runtime fail closed before business writes',async t=>{
 const f=setup(t),input={command_id:crypto.randomUUID(),name:'Synthetic'};assert.equal((await f.call('/api/sites/workspaces',input,{headers:{origin:'https://other.invalid'}})).status,403);assert.equal((await f.call('/api/sites/workspaces',{...input,authenticated:true})).status,400);assert.equal((await f.call('/api/sites/workspaces',{...input,name:'x'.repeat(131073)})).status,413);assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_workspaces').get().n,0);
 const response=await createCloudAuthoringApi()(new Request(f.origin+'/api/sites/workspaces'));assert.equal(response.status,503);assert.equal((await response.json()).error,'SITES_RUNTIME_BINDING_REQUIRED');
});
test('platform copy is explicit; new content version preserves old frozen task without granting approval',async t=>{
 const f=setup(t),{a,base}=await seed(f),one=content(a),saved=(await f.call(base+'/contents',one)).body,task=(await f.call(base+'/tasks',{command_id:crypto.randomUUID(),account_id:a,content_id:saved.id,expected_payload_hash:saved.payload_hash})).body;
 assert.equal((await f.call(base+'/contents',content(a,{revision:2,body:'Revised original body',variants:{xiaohongshu:{title:'XHS only',body:'Only Xiaohongshu'}}}))).status,200);const latest=(await f.call(base+'/contents?accountId='+a)).body.contents[0];assert.equal((await f.call(base+'/tasks',{command_id:crypto.randomUUID(),account_id:a,content_id:latest.id,expected_payload_hash:latest.payload_hash})).body.error,'EXPLICIT_PLATFORM_VARIANT_REQUIRED');
 const frozen=(await f.call(base+'/tasks?accountId='+a)).body.tasks.find(t=>t.id===task.id);assert.equal(frozen.snapshot.revision,1);assert.equal(frozen.snapshot.payload.body,one.variants.facebook.body);assert.equal(frozen.snapshot.source_status,'MANUAL_UNVERIFIED');assert.equal(frozen.canExecute,false);
});
