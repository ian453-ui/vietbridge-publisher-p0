import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {handoffFixture} from './fixtures/production-handoff.js';
import {syntheticAdmin,approvalCommand} from './fixtures/synthetic-approval.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {syntheticPublicationFactory} from '../src/synthetic-publication-driver.js';
import {unifiedDrivers} from '../src/unified-drivers.js';
import {handoffHash} from '../src/production-handoff-guard.js';

async function fixture(t,options){const root=mkdtempSync(join(tmpdir(),'v3-upload-plan-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const f=await handoffFixture(root,options);t.after(()=>f.store.close());return f;}
for(const video of [false,true])test('approved '+(video?'ZIP video':'ZIP image')+' -> native variant/job/frozen media -> single simulated submit and readback',async t=>{
 const f=await fixture(t,{video}),plan=f.prepare(),job=f.publisher.job(f.scope.workspace,plan.job_id);
 assert.equal(job.state,'DRAFT');assert.equal(plan.publish_allowed,false);assert.equal(plan.source_gate_satisfied,false);assert.equal(plan.media.length,1);assert.match(plan.media[0].mime,video?/video\/mp4/:/image\/png/);
 const asset=f.store.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=?').get(job.id),original=f.reviews.asset(f.scope.workspace,f.scope.accountId,f.reviewId,f.sourceId,video?'video':'cover');assert.equal(handoffHash(readFileSync(asset.path)),original.sha256);assert.equal(asset.sha256,plan.media[0].sha256);assert.equal(f.prepare().job_id,job.id);assert.equal(f.prepare().duplicate,true);
 const variant=f.publisher.contentVariants(plan.content_id).facebook;assert.equal(variant.body,plan.payload.body);assert.equal(job.snapshot.body,plan.payload.body);assert.ok(job.snapshot.productionReview);
 assert.equal(f.plans.prepare(f.reviewId,Object.fromEntries(Object.entries(f.input).reverse()),{accountId:f.scope.accountId,workspace:f.scope.workspace},{authority:syntheticAdmin}).job_id,job.id);
 f.executor.approve(f.scope.workspace,job.id,job.snapshot_hash);const attempts=await Promise.allSettled([f.executor.execute(f.scope.workspace,job.id),f.executor.execute(f.scope.workspace,job.id)]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.factory.stats().submits,1);
 const result=f.publisher.job(f.scope.workspace,job.id);assert.equal(result.state,'PUBLISHED');assert.equal(result.evidence.syntheticOnly,true);assert.equal(result.evidence.method,'LOCAL_SYNTHETIC_READBACK');assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM synthetic_publication_objects').get().n,1);await assert.rejects(()=>f.executor.execute(f.scope.workspace,job.id));assert.equal(f.factory.stats().submits,1);
});

test('production defaults and all normal approval/submit/clone/group paths remain closed despite global enabled',async t=>{
 const f=await fixture(t),plan=f.prepare(),job=f.publisher.job(f.scope.workspace,plan.job_id);let calls=0;const realFactory={create:async()=>{calls++;throw Error('MUST_NOT_CREATE_EXTERNAL_ADAPTER');}},real=new UnifiedExecutor(f.publisher,{...f.options,drivers:realFactory});
 assert.equal(real.executionCapability(f.scope.workspace,job.id).canExecute,false);assert.throws(()=>real.approve(f.scope.workspace,job.id,job.snapshot_hash),/NO_PUBLISH_AUTHORITY/);assert.throws(()=>f.publisher.approve(f.scope.workspace,job.id,job.snapshot_hash),/NO_PUBLISH_AUTHORITY/);await assert.rejects(()=>real.execute(f.scope.workspace,job.id),/NO_PUBLISH_AUTHORITY/);assert.throws(()=>f.publisher.manualComplete(f.scope.workspace,job.id,{}),/NO_PUBLISH_AUTHORITY/);await assert.rejects(()=>unifiedDrivers({}).create(job.snapshot),/NO_PUBLISH_AUTHORITY/);
 assert.throws(()=>f.publisher.importContent(f.scope.workspace,{source_id:'cloned',revision:'1',body:job.snapshot.body,media:job.snapshot.media}),/REQUIRES_BOUND_PLAN/);assert.throws(()=>f.store.createContent(f.scope.workspace,{body:job.snapshot.body,media:job.snapshot.media}),/REQUIRES_BOUND_PLAN/);assert.throws(()=>f.store.createGroupJobs(f.scope.workspace,{account_id:f.scope.accountId,content_ids:[plan.content_id],group_ids:['unused']}),/NO_GROUP_AUTHORITY/);
 assert.equal(calls,0);assert.equal(f.publisher.job(f.scope.workspace,job.id).state,'DRAFT');assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,0);
});

test('Xiaohongshu uses its own approved account, parsed title/tags and media variant without copying Facebook text',async t=>{
 const f=await fixture(t,{platform:'xiaohongshu'}),plan=f.prepare(),job=f.publisher.job(f.scope.workspace,plan.job_id);assert.equal(plan.platform,'xiaohongshu');assert.equal(plan.payload.title,'Synthetic XHS');assert.match(plan.payload.body,/distinct Xiaohongshu/);assert.deepEqual(plan.payload.tags,['Fixture']);assert.equal(job.account_id,f.demo.secondAccountId);assert.equal(f.publisher.contentVariants(plan.content_id).facebook,undefined);
 f.executor.approve(f.scope.workspace,job.id,job.snapshot_hash);const result=await f.executor.execute(f.scope.workspace,job.id);assert.equal(result.evidence.accountId,f.publisher.account(f.scope.workspace,f.scope.accountId).external_id);assert.equal(result.evidence.syntheticOnly,true);assert.equal(f.factory.stats().submits,1);
});

test('UNKNOWN review evidence fails closed before any upload plan',async t=>{
 const f=await fixture(t),row=f.store.db.prepare('SELECT report_json FROM production_reviews WHERE id=?').get(f.reviewId),report=JSON.parse(row.report_json);report.scope_status='UNKNOWN';const json=JSON.stringify(report);f.store.db.prepare('UPDATE production_reviews SET report_json=? WHERE id=?').run(json,f.reviewId);f.store.db.prepare('UPDATE production_review_envelopes SET report_sha256=? WHERE review_id=?').run(handoffHash(json),f.reviewId);assert.throws(()=>f.prepare(),/APPROVED_SYNTHETIC_SOURCE_REQUIRED/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_upload_plans').get().n,0);
});

test('exact scope/platform/body and current approval hashes are rechecked before upload preparation or simulation',async t=>{
 const f=await fixture(t);assert.throws(()=>f.plans.prepare(f.reviewId,f.input,f.scope,{authority:null}),/ADMIN_REQUIRED/);assert.throws(()=>f.plans.prepare(f.reviewId,f.input,{workspace:f.demo.otherWorkspace,accountId:f.demo.otherAccountId},{authority:syntheticAdmin}),/NOT_FOUND/);
 assert.throws(()=>f.plans.prepare(f.reviewId,{...f.input,payload_artifact_id:'article'},f.scope,{authority:syntheticAdmin}),/PLATFORM_PAYLOAD_REQUIRED/);assert.throws(()=>f.plans.prepare(f.reviewId,{...f.input,expected_subject:'f'.repeat(64)},f.scope,{authority:syntheticAdmin}),/APPROVAL_CHANGED/);
 const plan=f.prepare(),job=f.publisher.job(f.scope.workspace,plan.job_id);assert.throws(()=>f.publisher.createPageJob(f.scope.workspace,{account_id:f.demo.secondAccountId,content_id:plan.content_id}),/平台|SCOPE_DENIED/);assert.throws(()=>f.publisher.createPageJob(f.scope.workspace,{account_id:f.scope.accountId,content_id:plan.content_id,payload:{body:'Edited after approval'}}),/PAYLOAD_CHANGED/);
 const frozen=f.store.db.prepare('SELECT path FROM publisher_job_assets WHERE job_id=?').get(job.id).path,frozenBytes=readFileSync(frozen);writeFileSync(frozen,'bad frozen copy');assert.throws(()=>f.prepare(),/MEDIA_CHANGED/);writeFileSync(frozen,frozenBytes);
 const bytes=readFileSync(job.snapshot.media[0]);writeFileSync(job.snapshot.media[0],Buffer.from('modified'));assert.throws(()=>f.executor.approve(f.scope.workspace,job.id,job.snapshot_hash),/MEDIA_CHANGED/);writeFileSync(job.snapshot.media[0],bytes);
 f.store.db.prepare('UPDATE facebook_accounts SET target_page_id=? WHERE id=?').run('900000000000099',f.scope.accountId);assert.throws(()=>f.prepare(),/APPROVED_SYNTHETIC_SOURCE_REQUIRED/);assert.equal(f.reviews.approvals.view(f.reviewId,f.scope).state,'REVOKED');assert.equal(f.factory.stats().submits,0);
});

test('unverified producer results never unlock the plan',async t=>{
 const f=await fixture(t);f.store.db.prepare('DELETE FROM production_review_provenance WHERE review_id=?').run(f.reviewId);assert.throws(()=>f.prepare(),/APPROVED_SYNTHETIC_SOURCE_REQUIRED/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_upload_plans').get().n,0);
});

test('upload failure records preparation without submission; duplicate planning never replaces the blocked task',async t=>{
 const f=await fixture(t,{video:true}),plan=f.prepare(),job=f.publisher.job(f.scope.workspace,plan.job_id);f.executor.approve(f.scope.workspace,job.id,job.snapshot_hash);f.factory.setFault('UPLOAD_FAILED');await assert.rejects(()=>f.executor.execute(f.scope.workspace,job.id),/UPLOAD_FAILED/);assert.equal(f.publisher.job(f.scope.workspace,job.id).state,'BLOCKED');assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,0);assert.equal(f.factory.stats().submits,0);assert.equal(f.prepare().job_id,job.id);await assert.rejects(()=>f.executor.execute(f.scope.workspace,job.id));assert.equal(f.factory.stats().prepares,1);
});

test('lost submit response persists UNKNOWN; restarted simulator only reconciles original evidence, including later approval revocation',async t=>{
 const f=await fixture(t,{video:true}),plan=f.prepare(),job=f.publisher.job(f.scope.workspace,plan.job_id);f.executor.approve(f.scope.workspace,job.id,job.snapshot_hash);f.factory.setFault('SUBMIT_RESPONSE_LOST');await assert.rejects(()=>f.executor.execute(f.scope.workspace,job.id),/RESPONSE_LOST/);assert.equal(f.publisher.job(f.scope.workspace,job.id).state,'UNKNOWN');await assert.rejects(()=>f.executor.execute(f.scope.workspace,job.id));assert.equal(f.factory.stats().submits,1);
 const approval=f.reviews.approvals.view(f.reviewId,f.scope,{admin:true});f.reviews.approvals.decide(f.reviewId,approvalCommand(approval,{decision:'REJECT',reason:'Later synthetic review rejection'}),f.scope,{authority:syntheticAdmin});
 assert.throws(()=>f.prepare(),/APPROVED_SYNTHETIC_SOURCE_REQUIRED/);
 const script=`import {Store} from './src/store.js';import {UnifiedPublisher} from './src/unified-publisher.js';import {UnifiedExecutor} from './src/unified-executor.js';import {BrowserResources} from './src/browser-resources.js';import {syntheticPublicationFactory} from './src/synthetic-publication-driver.js';const x=JSON.parse(process.argv[1]),s=new Store(x.db,{seedDemo:false}),p=new UnifiedPublisher(s),factory=syntheticPublicationFactory(s.db),e=new UnifiedExecutor(p,{enabled:true,drivers:factory,resources:new BrowserResources(x.locks),snapshotRoot:x.snapshots});try{const result=await e.reconcile(x.workspace,x.job);console.log(JSON.stringify({state:result.state,evidence:result.evidence,stats:factory.stats()}));}finally{s.close();}`;
 const output=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,JSON.stringify({db:f.demo.dbPath,locks:join(f.root,'locks'),snapshots:join(f.root,'job-assets'),workspace:f.scope.workspace,job:job.id})],{cwd:process.cwd(),timeout:15000}),result=JSON.parse(output.stdout);assert.equal(result.state,'PUBLISHED');assert.equal(result.evidence.syntheticOnly,true);assert.deepEqual(result.stats,{prepares:0,submits:0,reads:1});assert.equal(f.store.db.prepare('SELECT count(*) n FROM synthetic_publication_objects').get().n,1);await assert.rejects(()=>f.executor.reconcile(f.scope.workspace,job.id));
});

test('late database fault rolls back native content, plan, job, frozen BLOB metadata and audit together',async t=>{
 const f=await fixture(t);f.store.db.exec("CREATE TRIGGER synthetic_plan_fault BEFORE INSERT ON production_upload_jobs BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PLAN_COMMIT_FAILURE'); END");assert.throws(()=>f.prepare(),/COMMIT_FAILURE/);
 for(const table of ['production_upload_plans','production_upload_bindings','production_upload_jobs','group_content','publisher_jobs','publisher_job_assets','publisher_content_sources','publisher_content_variants'])assert.equal(f.store.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE event='production_upload_preview_prepared'").get().n,0);assert.deepEqual(readdirSync(join(f.root,'upload-media')),[]);assert.deepEqual(readdirSync(join(f.root,'job-assets')),[]);f.store.db.exec('DROP TRIGGER synthetic_plan_fault');assert.equal(f.prepare().duplicate,false);
});

test('two SQLite connections preparing the same approved version share one native task and media plan',async t=>{
 const f=await fixture(t),script=`import {Store} from './src/store.js';import {UnifiedPublisher} from './src/unified-publisher.js';import {UnifiedExecutor} from './src/unified-executor.js';import {ProductionUploadPlans} from './src/production-upload-plan.js';import {syntheticAdmin} from './test/fixtures/synthetic-approval.js';const x=JSON.parse(process.argv[1]),s=new Store(x.db,{seedDemo:false}),p=new UnifiedPublisher(s),e=new UnifiedExecutor(p,{snapshotRoot:x.snapshots}),h=new ProductionUploadPlans(p,e,{root:x.root});try{console.log(JSON.stringify(h.prepare(x.review,x.input,x.scope,{authority:syntheticAdmin})));}finally{s.close();}`;
 const arg=JSON.stringify({db:f.demo.dbPath,snapshots:join(f.root,'job-assets'),root:join(f.root,'upload-media'),review:f.reviewId,input:f.input,scope:f.scope}),run=()=>promisify(execFile)(process.execPath,['--input-type=module','-e',script,arg],{cwd:process.cwd(),timeout:20000});const outcomes=await Promise.all([run(),run()]),plans=outcomes.map(x=>JSON.parse(x.stdout));assert.equal(plans[0].job_id,plans[1].job_id);assert.deepEqual(plans.map(p=>p.duplicate).sort(),[false,true]);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);
});
