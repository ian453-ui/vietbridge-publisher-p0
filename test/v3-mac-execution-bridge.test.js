import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {V3MacExecutionBridge} from '../src/v3-mac-execution-bridge.js';

const siteProjectId='appgprj_6ad97a034fd08191a8399eeda10f048c';
const siteJobId='e11a0a0b-36d1-4b96-a547-650324836d48';
const localJobId='5ee5f131-338e-4d65-bc34-1e34dc4c9a80';
const siteWorkspaceId='197d8d12-ae97-455a-a484-941db62adbd0';
const siteAccountId='106fb398-78db-4485-93ce-e88207f0a066';
const siteHash='a'.repeat(64),localHash='b'.repeat(64);
const admin={kind:'EXISTING_ADMIN',actor_id:'admin:'+'f'.repeat(64)};
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE publisher_jobs(id TEXT PRIMARY KEY,workspace TEXT,account_id TEXT,content_id TEXT,snapshot_hash TEXT,state TEXT,attempt_id TEXT,evidence_json TEXT,updated_at TEXT); CREATE TABLE publisher_submit_receipts(job_id TEXT PRIMARY KEY,platform_id TEXT,platform_url TEXT,created_at TEXT); CREATE TABLE publisher_content_sources(workspace TEXT,source_id TEXT,revision TEXT,content_id TEXT)");
 db.prepare('INSERT INTO publisher_jobs VALUES(?,?,?,?,?,?,?,?,?)').run(localJobId,'ws-enterprise','account-enterprise','content-1',localHash,'READY',null,'{}','2026-10-24T00:00:00Z');
 db.prepare('INSERT INTO publisher_content_sources VALUES(?,?,?,?)').run('ws-enterprise','sites:'+siteProjectId+':'+siteJobId,siteHash,'content-1');
 const store={tx(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const publisher={db,store,job(workspace,id){const row=db.prepare('SELECT * FROM publisher_jobs WHERE workspace=? AND id=?').get(workspace,id);if(!row)throw Error('NO_LOCAL_JOB');return {...row,evidence:JSON.parse(row.evidence_json)};},assertCurrent(job){if(job.state==='CANCELLED')throw Error('STALE_LOCAL_JOB');}};
 let calls=0,reconciles=0,allowed=true;
 const executor={executionCapability(){return {canExecute:allowed,mode:'TEST_LOCAL_POLICY'};},async execute(workspace,id,input){calls++;assert.equal(workspace,'ws-enterprise');assert.equal(id,localJobId);assert.deepEqual(input,{confirm:true,snapshot_hash:localHash});db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='attempt-1' WHERE id=?").run(id);throw Error('SUBMISSION_RESULT_UNKNOWN');},async reconcile(workspace,id,input){reconciles++;assert.equal(workspace,'ws-enterprise');assert.equal(id,localJobId);assert.deepEqual(input,{platform_id:'post123'});db.prepare("UPDATE publisher_jobs SET state='PUBLISHED',evidence_json=? WHERE id=?").run(JSON.stringify({id:'post123',url:'https://example.test/post123',verified:true}),id);}};
 const bridge=new V3MacExecutionBridge(publisher,executor,{siteProjectId});
 const link={site_project_id:siteProjectId,site_job_id:siteJobId,site_workspace_id:siteWorkspaceId,site_account_id:siteAccountId,site_snapshot_hash:siteHash,local_workspace_id:'ws-enterprise',local_account_id:'account-enterprise',local_job_id:localJobId,local_snapshot_hash:localHash};
 return {db,bridge,link,calls:()=>calls,reconciles:()=>reconciles,setAllowed(value){allowed=value;}};
}

test('V3 binding is exact, admin only, idempotent and rejects another customer or changed snapshot',t=>{
 const f=fixture(t);
 assert.throws(()=>f.bridge.bind(f.link),/APPROVAL_ADMIN_REQUIRED/);
 assert.throws(()=>f.bridge.bind({...f.link,local_workspace_id:'ws-other'},{authority:admin}),/NO_LOCAL_JOB/);
 assert.throws(()=>f.bridge.bind({...f.link,local_snapshot_hash:'c'.repeat(64)},{authority:admin}),/V3_LOCAL_JOB_CHANGED/);
 f.db.prepare('DELETE FROM publisher_content_sources').run();
 assert.throws(()=>f.bridge.bind(f.link,{authority:admin}),/V3_SITE_SOURCE_NOT_IMPORTED/);
 f.db.prepare('INSERT INTO publisher_content_sources VALUES(?,?,?,?)').run('ws-enterprise','sites:'+siteProjectId+':'+siteJobId,siteHash,'content-1');
 assert.equal(f.bridge.bind(f.link,{authority:admin}).duplicate,false);
 assert.equal(f.bridge.bind(f.link,{authority:admin}).duplicate,true);
 assert.throws(()=>f.bridge.bind({...f.link,site_account_id:'39786221-4438-4b94-8651-ff31f6049113'},{authority:admin}),/V3_BINDING_CONFLICT/);
 assert.throws(()=>f.bridge.bind({...f.link,site_job_id:'39786221-4438-4b94-8651-ff31f6049113'},{authority:admin}),/V3_SITE_SOURCE_NOT_IMPORTED/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM publisher_v3_job_bindings').get().n,1);
});

test('V3 dispatch delegates to the original executor once; UNKNOWN can only reconcile, never replay',async t=>{
 const f=fixture(t);f.bridge.bind(f.link,{authority:admin});
 const confirmation={confirm:true,local_snapshot_hash:localHash,site_snapshot_hash:siteHash};
 await assert.rejects(f.bridge.dispatch(siteJobId,{...confirmation,local_snapshot_hash:'c'.repeat(64)}),/V3_EXACT_CONFIRMATION_REQUIRED/);
 f.setAllowed(false);await assert.rejects(f.bridge.dispatch(siteJobId,confirmation),/V3_LOCAL_EXECUTION_UNAVAILABLE/);assert.equal(f.calls(),0);
 f.setAllowed(true);await assert.rejects(f.bridge.dispatch(siteJobId,confirmation),/SUBMISSION_RESULT_UNKNOWN/);
 assert.equal(f.bridge.status(siteJobId).state,'UNKNOWN');
 assert.equal((await f.bridge.dispatch(siteJobId,confirmation)).already_claimed,true);assert.equal(f.calls(),1);
 await f.bridge.reconcile(siteJobId,{site_snapshot_hash:siteHash,local_snapshot_hash:localHash,platform_id:'post123'});
 assert.equal(f.bridge.status(siteJobId).state,'PUBLISHED');assert.equal(f.bridge.status(siteJobId).verified,true);
 assert.equal((await f.bridge.dispatch(siteJobId,confirmation)).already_claimed,true);assert.equal(f.calls(),1);assert.equal(f.reconciles(),1);
});
