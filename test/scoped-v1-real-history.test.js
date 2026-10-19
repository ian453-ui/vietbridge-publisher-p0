import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setup} from './helpers/scoped-fixture.js';
import {ScopedOperations} from '../src/scoped-operations.js';
import {scopeDigest} from '../src/task-action-permit.js';
import {openDatabase} from '../legacy-p0/src/database.ts';
import {DatabaseSync} from 'node:sqlite';
import {PublisherStore} from '../legacy-p0/src/publisher-store.ts';

// Actual reviewed V1 schema/store and task-service canonical_payload_json shape.
function history(t, {state='PUBLISHED', body='Actual V1 string body', today=false, mirror, safety}={}) {
 const f=setup(t),path=join(f.root,'real-v1.sqlite'),db=openDatabase(path),store=new PublisherStore(db);
 const date=new Date(Date.now()-(today?0:10*86400000)).toISOString();
 db.prepare('INSERT INTO facebook_accounts(id,display_name,page_id,page_name,config_url,enabled,updated_at) VALUES(?,?,?,?,?,?,?)').run('legacy-page','LP',f.account.target_page_id,'LP','fixture-no-credentials',1,date);
 const id=store.createJob({articleId:'OLD',platform:'facebook',accountId:'legacy-page',packageHash:'fixture-package'});
 db.prepare('UPDATE jobs SET state=?,current_attempt_id=?,submitted_at=?,published_at=?,updated_at=?,submit_safety_domain=? WHERE job_id=?').run(mirror?'USER_APPROVED':state,mirror?null:'old-attempt',mirror?null:date,state.startsWith('PUBLISHED')?date:null,date,safety||(mirror?'BEFORE_EXTERNAL_SUBMIT':'MAY_HAVE_SUBMITTED'),id);
 db.prepare('INSERT INTO content_snapshots(snapshot_id,article_id,content_version,manifest_hash,canonical_payload_json,source_kind,staging_root,created_at) VALUES(?,?,?,?,?,?,?,?)').run('old-snapshot','OLD','1','manifest',JSON.stringify({articleId:'OLD',version:'1',payloads:{facebook:body}}),'LOCAL',f.root,date);
 const events=join(f.root,'events.jsonl'),verified=join(f.root,'verified.jsonl'),yaml=join(f.root,'ledger.yaml');
 writeFileSync(events,mirror==='events'?JSON.stringify({event_id:'old-event',job_id:id,event_type:'STATE_TRANSITION',payload:{from:'FORM_FILLED',to:state},created_at:date})+'\n':'');
 writeFileSync(verified,mirror==='verified'?JSON.stringify({job_id:id,platform:'facebook',status:state,verified_at:date})+'\n':'');
 writeFileSync(yaml,mirror==='yaml'?`published_history:\n  OLD:\n    facebook:\n      job_id: ${id}\n      status: ${state}\n      published_at: ${date}\n`:'published_history: {}\n');
 db.close();const policy={...f.policy,additional_history:[{kind:'V1',path,ledger_paths:{events:[events,verified],yaml}}]};
 const ops=new ScopedOperations(f.executor,f.facebook,{policy,mediaRoots:[f.root],snapshotRoot:join(f.root,'snapshots')});f.executor.scopedOperations=ops;return Object.assign(f,{ops,path});
}
for(const state of ['UNKNOWN','SUBMITTED_PENDING_CONFIRMATION']) test(`NO-GO P1: real V1 ${state} remains blocking across UTC days at capability and claim`, async t=>{
 const f=history(t,{state}),j=f.makePage('New different approved body'),cap=f.executor.executionCapability(f.w.id,j.id);
 assert.equal(cap.canExecute,false,JSON.stringify(cap));
 await assert.rejects(()=>f.executor.execute(f.w.id,j.id,{confirm:true,scope_hash:cap.scopeHash||'0'.repeat(64)}));
 assert.equal(f.creates,0);assert.equal(f.submissions,0);assert.equal(f.ops.permits.read('PAGE:'+j.id),undefined);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,0);
});
test('NO-GO P2: real V1 past published string body allows different new content and mock claim',async t=>{
 const f=history(t),j=f.makePage('New different approved body'),cap=f.executor.executionCapability(f.w.id,j.id);
 assert.equal(cap.canExecute,true,cap.reason);await f.executor.execute(f.w.id,j.id,{confirm:true,scope_hash:cap.scopeHash});assert.equal(f.submissions,1);
});
test('real V1 past published string body retains permanent same-content dedupe',t=>{
 const f=history(t),j=f.makePage('Actual V1 string body');assert.equal(f.executor.executionCapability(f.w.id,j.id).canExecute,false);assert.equal(f.creates,0);
});
test('real V1 current-day different published string body consumes only current daily quota',t=>{
 const f=history(t,{today:true}),j=f.makePage('New different approved body');assert.equal(f.executor.executionCapability(f.w.id,j.id).reason,'PAGE_DAILY_LIMIT_1');
});
for(const mirror of ['events','verified','yaml']) for(const state of ['UNKNOWN','SUBMITTED_PENDING_CONFIRMATION']) test(`real V1 ${mirror} mirror ${state} remains pending across days`,t=>{
 const f=history(t,{state,mirror}),j=f.makePage('New different body');assert.equal(f.executor.executionCapability(f.w.id,j.id).canExecute,false);
});
test('real V1 failed state still MAY_HAVE_SUBMITTED cannot silently conclude an old attempt',t=>{
 const f=history(t,{state:'FAILED'}),j=f.makePage('Different new body');assert.equal(f.executor.executionCapability(f.w.id,j.id).canExecute,false);
});

for(const state of ['UNKNOWN','SUBMITTED_PENDING_CONFIRMATION']) test(`NO-GO P1 claim bypass counterexample: ${state} rejects a valid current scope without first reading capability`,async t=>{
 const f=history(t,{state}),j=f.makePage('Different exact claim counterexample'),scope_hash=scopeDigest(f.ops.describe('PAGE',j.id).scope);
 await assert.rejects(()=>f.executor.execute(f.w.id,j.id,{confirm:true,scope_hash}),/HISTORICAL_PENDING/);
 assert.equal(f.creates,0);assert.equal(f.submissions,0);assert.equal(f.ops.permits.read('PAGE:'+j.id),undefined);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,0);
});

test('current verified completed V1 job resolves a stale UNKNOWN mirror without losing same-body history',async t=>{
 const f=history(t,{state:'UNKNOWN',mirror:'events'}),db=new DatabaseSync(f.path);db.prepare("UPDATE jobs SET state='PUBLISHED',published_at=updated_at WHERE platform='facebook'").run();db.close();
 const j=f.makePage('Different body after independent completion'),cap=f.executor.executionCapability(f.w.id,j.id);assert.equal(cap.canExecute,true,cap.reason);
 await f.executor.execute(f.w.id,j.id,{confirm:true,scope_hash:cap.scopeHash});assert.equal(f.submissions,1);
});
test('confirmed no-external-submit historical failure does not permanently block other content',t=>{
 const f=history(t,{state:'FAILED',safety:'BEFORE_EXTERNAL_SUBMIT'}),j=f.makePage('Different content after resolved absence');
 assert.equal(f.executor.executionCapability(f.w.id,j.id).canExecute,true);
});
