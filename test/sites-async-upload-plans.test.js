import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {approvalFixture,syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {AsyncUploadPlans} from '../src/sites/async-upload-plans.js';
async function ready(t){const x=await approvalFixture(t,{video:true}),approved=await x.approvals.decide(x.id,approvalCommand(await x.approvals.view(x.id,x.scope)),x.scope,{authority:syntheticAdmin}),plans=new AsyncUploadPlans(x.f.db,x.options),choice=(await plans.choices(x.id,x.scope))[0],input={expected_subject:approved.approval.subject_fingerprint,expected_event_id:approved.event_id,source_id:choice.source_id,payload_artifact_id:choice.payload_artifact_id};return {...x,plans,input};}
const prepare=x=>x.plans.prepare(x.id,x.input,x.scope,{authority:syntheticAdmin});
test('review bytes -> explicit platform variant -> existing frozen DRAFT, idempotent and persistent',async t=>{
 const x=await ready(t),before=x.f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n;
 const results=await Promise.all([prepare(x),prepare(x)]);assert.equal(results[0].id,results[1].id);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,before+1);
 const p=results[0];assert.equal(p.payload.body,'Synthetic explicitly approved platform copy.');assert.equal(p.media.length,1);assert.equal(p.media[0].mime,'video/mp4');assert.equal(p.publish_allowed,false);assert.equal(p.job_state,'DRAFT');
 const fresh=cloudD1Fixture(x.path,{initialize:false});try{const reloaded=await new AsyncUploadPlans(fresh.db,x.options).view(p.id,x.scope);assert.deepEqual(reloaded.media,p.media);assert.equal(reloaded.publication_authority.state,'UNCONFIGURED');}finally{fresh.close();}
 const frozen=JSON.parse(x.f.sql.prepare('SELECT snapshot_json FROM sites_job_snapshots WHERE job_id=?').get(p.job_id).snapshot_json);assert.equal(frozen.media[0].sha256,p.media[0].sha256);assert.equal(frozen.production_plan.approval_event_id,x.input.expected_event_id);
});
for(const change of ['revoke','membership','account','database'])test('prepare barrier '+change+' rolls back content, plan and frozen job',async t=>{
 const x=await ready(t),base=x.f.db.batch,before=x.f.sql.prepare('SELECT count(*) n FROM sites_contents').get().n;let fired=false;
 x.f.db.batch=async ss=>{if(!fired&&ss.some(s=>s.query.startsWith('INSERT INTO sites_upload_plans'))){fired=true;const other=new DatabaseSync(x.path);try{
  if(change==='revoke')other.prepare("INSERT INTO sites_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,'CONTENT_REJECTED',?,'withdrawn','{}',?)").run(crypto.randomUUID(),x.id,x.input.expected_subject,syntheticAdmin.actor_id,new Date().toISOString());
  if(change==='membership')other.prepare('UPDATE sites_project_memberships SET revoked_at=?').run(new Date().toISOString());
  if(change==='account')other.prepare("UPDATE sites_account_details SET external_identity='CHANGED'").run();
  if(change==='database')x.f.fault=ss.length-2;
 }finally{other.close();}}try{return await base(ss);}finally{x.f.fault=-1;}};
 await assert.rejects(prepare(x),/PRODUCTION_APPROVAL_CHANGED|SCOPE_DENIED|SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_contents').get().n,before);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_upload_plans').get().n,0);
});
test('object corruption refuses preparation, keeps immutable evidence for recovery, wrong scope refused',async t=>{
 const x=await ready(t),row=x.f.sql.prepare("SELECT * FROM sites_objects WHERE mime='video/mp4'").get();writeFileSync(x.bucket.file(row.object_key),'bad');await assert.rejects(prepare(x),/PRODUCTION_APPROVED_SYNTHETIC_SOURCE_REQUIRED/);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_upload_plans').get().n,0);await assert.rejects(x.plans.prepare(x.id,x.input,{...x.scope,accountId:'wrong'},{authority:syntheticAdmin}),/STORAGE_SCOPE_DENIED/);
});
test('prepared preview becomes stale after rejection; old receipt remains readable but new preparation is blocked',async t=>{
 const x=await ready(t),p=await prepare(x);await x.approvals.decide(x.id,approvalCommand(await x.approvals.view(x.id,x.scope),{decision:'REJECT',reason:'withdraw'}),x.scope,{authority:syntheticAdmin});assert.equal((await x.plans.view(p.id,x.scope)).status,'STALE_PREVIEW');const old=await prepare(x);assert.equal(old.committed,true);assert.equal(old.duplicate,true);assert.equal(old.id,p.id);assert.equal(old.status,'STALE_PREVIEW');await assert.rejects(x.plans.prepare(x.id,{...x.input,payload_artifact_id:'different-payload'},x.scope,{authority:syntheticAdmin}),/PRODUCTION_APPROVED_SYNTHETIC_SOURCE_REQUIRED/);
});

test('prepare commit acknowledgement loss returns committed plan, no second content or job',async t=>{const x=await ready(t),base=x.f.db.batch;x.f.db.batch=async ss=>{const r=await base(ss);if(ss.some(s=>s.query.startsWith('INSERT INTO sites_upload_plans')))throw Error('LOST_COMMIT_ACK');return r;};const p=await prepare(x);assert.equal(p.committed,true);assert.equal((await prepare(x)).id,p.id);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_upload_plans').get().n,1);});
