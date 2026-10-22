import test from 'node:test';
import assert from 'node:assert/strict';
import {sitesEvidenceFixture} from './fixtures/sites-evidence.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {AsyncMetricStore} from '../src/sites/async-metric-store.js';
import {ScopedObjectStore} from '../src/sites/scoped-object-store.js';
import {fileBucket} from './fixtures/sites-evidence.js';
import {metricPacket,metricNow} from './fixtures/synthetic-metrics.js';
import {join} from 'node:path';

for(const operation of ['contents','tasks','accounts'])test(operation+' rechecks current owner/membership inside the write batch after a deterministic second-connection revocation',{timeout:10000},async t=>{
 const f=await sitesEvidenceFixture(t),second=cloudD1Fixture(f.path,{initialize:false});t.after(()=>second.close());const command=crypto.randomUUID(),base='/api/sites/workspaces/'+f.workspace;
 const input=operation==='contents'?{command_id:command,account_id:f.accountId,content_id:'SYNTHETIC-20261022-075',slug:'revocation-race',revision:1,title:'Synthetic',body:'Must not commit after revocation',variants:{facebook:{title:'Synthetic',body:'Must not commit after revocation'}}}:operation==='tasks'?{command_id:command,account_id:f.accountId,content_id:f.target.content_id,expected_payload_hash:f.f.sql.prepare('SELECT payload_hash FROM sites_contents WHERE id=?').get(f.target.content_id).payload_hash}:{command_id:command,display_name:'Must not create',platform:'facebook',external_identity:null};
 // The original task exists, so give TASK an immutable, newly saved revision.
 if(operation==='tasks'){const created=await f.post(base+'/contents',{account_id:f.accountId,content_id:'SYNTHETIC-20261022-076',slug:'unfrozen',revision:1,title:'Unfrozen',body:'Unfrozen',variants:{facebook:{title:'Unfrozen',body:'Unfrozen'}}});input.content_id=created.id;input.expected_payload_hash=created.payload_hash;}
 const tables=['sites_contents','publisher_jobs','sites_account_details','sites_project_memberships','sites_authoring_commands','publisher_content_sources','sites_job_snapshots'],counts=()=>Object.fromEntries(tables.map(table=>[table,f.f.sql.prepare('SELECT count(*) n FROM '+table).get().n])),before=counts();
 let reached,release;const atBatch=new Promise(r=>{reached=r;}),barrier=new Promise(r=>{release=r;}),batch=f.f.db.batch;f.f.db.batch=async statements=>{reached();await barrier;return batch(statements);};
 const pending=f.f.call(base+'/'+operation,input);await atBatch;
 if(operation==='accounts')second.sql.prepare('UPDATE sites_workspaces SET owner_user_id=? WHERE id=?').run('different-owner',f.workspace);
 else second.sql.prepare('UPDATE sites_project_memberships SET revoked_at=? WHERE workspace=? AND account_id=?').run(new Date().toISOString(),f.workspace,f.accountId);
 release();const result=await pending;assert.deepEqual({status:result.status,counts:counts(),command_rows:f.f.sql.prepare('SELECT count(*) n FROM sites_authoring_commands WHERE command_id=?').get(command).n},{status:403,counts:before,command_rows:0});
});

test('authorized async metric ingestion rechecks membership in its atomic raw/observation batch',{timeout:10000},async t=>{
 const f=await sitesEvidenceFixture(t),second=cloudD1Fixture(f.path,{initialize:false});t.after(()=>second.close());const authorization={userId:'synthetic-owner',...f.scope},store=new AsyncMetricStore(f.f.db,{authorization}),id=(await store.registerTarget(f.target)).id;
 let reached,release;const atBatch=new Promise(r=>{reached=r;}),barrier=new Promise(r=>{release=r;}),batch=f.f.db.batch;f.f.db.batch=async statements=>{reached();await barrier;return batch(statements);};const pending=store.ingest(id,metricPacket(f.target),{...f.scope,now:metricNow});await atBatch;second.sql.prepare('UPDATE sites_project_memberships SET revoked_at=? WHERE account_id=?').run(new Date().toISOString(),f.accountId);release();await assert.rejects(()=>pending,/SCOPE_DENIED/);
 for(const table of ['metric_series','metric_observations','metric_raw_evidence','sites_write_assertions','sites_authorization_assertions'])assert.equal(f.f.sql.prepare('SELECT count(*) n FROM '+table).get().n,0,table);
});
test('object verification cannot commit READY after membership revocation during readback',{timeout:10000},async t=>{
 const f=await sitesEvidenceFixture(t),second=cloudD1Fixture(f.path,{initialize:false});t.after(()=>second.close());const bucket=fileBucket(join(f.root,'objects')),raw=new ScopedObjectStore(f.f.db,bucket),object=await raw.put({...f.scope,review_id:'synthetic-race',source_id:'SYNTHETIC-074',artifact_id:'body'},new TextEncoder().encode('Synthetic private bytes'),'text/plain; charset=utf-8');f.f.sql.prepare("UPDATE sites_objects SET state='STAGED' WHERE id=?").run(object.id);
 const store=new ScopedObjectStore(f.f.db,bucket,{authorization:{userId:'synthetic-owner',...f.scope}});let reached,release;const atBatch=new Promise(r=>{reached=r;}),barrier=new Promise(r=>{release=r;}),batch=f.f.db.batch;f.f.db.batch=async statements=>{reached();await barrier;return batch(statements);};const pending=store.verify(object.id,f.scope);await atBatch;second.sql.prepare('UPDATE sites_project_memberships SET revoked_at=? WHERE account_id=?').run(new Date().toISOString(),f.accountId);release();await assert.rejects(()=>pending,/SCOPE_DENIED/);assert.equal(f.f.sql.prepare('SELECT state FROM sites_objects WHERE id=?').get(object.id).state,'STAGED');assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_authorization_assertions').get().n,0);
});
