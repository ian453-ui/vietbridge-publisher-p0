import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
import {ScopedOperations} from '../src/scoped-operations.js';
import {executionScope} from '../src/single-execution-permit.js';
import {observePublicationAuthority} from '../src/production-publication-authority.js';
import {handoffFixture} from './fixtures/production-handoff.js';

function setup(t){const root=mkdtempSync(join(tmpdir(),'v3-authority-')),store=new Store(join(root,'db.sqlite'),{seedDemo:false}),publisher=new UnifiedPublisher(store),w=store.saveWorkspace({name:'Synthetic authority',content_root:root}),profile=store.saveProfile(w.id,{name:'Synthetic',cdp_port:19892,user_data_dir:join(root,'profile')}),a=publisher.saveAccount(w.id,{display_name:'Synthetic',identity_type:'PAGE',expected_identity:'Synthetic',profile_id:profile.id,external_id:'900000000000002',operator_actor_id:'900000000000002',target_page_id:'900000000000001'});let creates=0;
 const executor=new UnifiedExecutor(publisher,{enabled:false,resources:new BrowserResources(join(root,'locks')),mediaRoots:[root],snapshotRoot:join(root,'snapshots'),drivers:{create:async()=>{creates++;throw Error('NO_EXTERNAL_TRANSPORT');}}}),authorization={task_id:'synthetic-test-task',approval_thread_id:'synthetic-test-thread',approval_message_id:'synthetic-test-message'},policy={workspace:w.id,account_id:a.id,actor_id:a.operator_actor_id,target_page_id:a.target_page_id,operations:['PAGE'],additional_history:[],expires_at:Date.now()+60000,authorization};
 const make=(body='Synthetic copy')=>{const c=publisher.importContent(w.id,{source_id:'synthetic-'+Math.random(),revision:'1',body,media:[]}),j=publisher.createPageJob(w.id,{content_id:c.id,account_id:a.id});executor.approve(w.id,j.id,j.snapshot_hash);return publisher.job(w.id,j.id);};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,store,publisher,w,a,executor,authorization,policy,make,observe:j=>observePublicationAuthority(executor,w.id,a.id,j.id),get creates(){return creates;}};
}
test('authority observation only reads existing exact permits; global switch/client flags cannot grant; revoked legacy never falls back',t=>{
 const f=setup(t),j=f.make();f.executor.enabled=true;assert.equal(f.observe(j).mechanism,'NONE');assert.equal(f.observe(j).eligible,false);f.executor.enabled=false;
 f.executor.permits.issue(f.w.id,j.id,executionScope(j),{expiresAt:Date.now()+60000,authorization:f.authorization});const evidence=f.observe(j);assert.equal(evidence.mechanism,'SINGLE_EXECUTION_PERMIT');assert.equal(evidence.eligible,true);assert.equal(evidence.can_execute,false);assert.equal(f.executor.permits.record(j.id).status,'AVAILABLE');assert.equal(f.creates,0);
 assert.throws(()=>observePublicationAuthority(f.executor,f.w.id,'another-account',j.id),/PUBLICATION_AUTHORITY_SCOPE_DENIED/);
 f.executor.scopedOperations=new ScopedOperations(f.executor,{}, {policy:f.policy,mediaRoots:[f.root],snapshotRoot:join(f.root,'snapshots')});f.executor.permits.revoke(f.w.id,j.id,'synthetic-revocation');assert.equal(f.observe(j).status,'REVOKED');assert.equal(f.observe(j).mechanism,'SINGLE_EXECUTION_PERMIT');assert.equal(f.observe(j).eligible,false);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permits').get().n,0);assert.equal(f.creates,0);
});
test('scoped policy stays exact-confirmation-only and preserves quotas, consumed state, UNKNOWN and duplicate protection',t=>{
 const f=setup(t),j=f.make();f.executor.scopedOperations=new ScopedOperations(f.executor,{}, {policy:f.policy,mediaRoots:[f.root],snapshotRoot:join(f.root,'snapshots')});let observation=f.observe(j);assert.equal(observation.status,'EXACT_CONFIRMATION_REQUIRED');assert.equal(observation.eligible,true);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permits').get().n,0);
 f.executor.claim(f.w.id,j.id,{confirm:true,scope_hash:observation.scope_hash});f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(j.id);assert.equal(f.observe(j).eligible,false);assert.equal(f.observe(j).status,'CONSUMED');const other=f.make('Another synthetic copy');assert.equal(f.observe(other).eligible,false);f.store.db.prepare("UPDATE publisher_jobs SET state='PUBLISHED' WHERE id=?").run(j.id);assert.match(f.observe(other).reason,/PAGE_DAILY_LIMIT_1/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,1);assert.equal(f.creates,0);
});
test('reviewed media is not compatible with text-only permits and source evidence cannot enable a real driver',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-authority-media-')),f=await handoffFixture(root);t.after(()=>{f.store.close();rmSync(root,{recursive:true,force:true});});const plan=f.prepare();f.executor.approve(f.scope.workspace,plan.job_id,f.publisher.job(f.scope.workspace,plan.job_id).snapshot_hash);const j=f.publisher.job(f.scope.workspace,plan.job_id);
 assert.throws(()=>f.executor.permits.issue(f.scope.workspace,j.id,executionScope(j),{expiresAt:Date.now()+60000,authorization:{task_id:'test',approval_thread_id:'test',approval_message_id:'test'}}),/文本|纯文字|媒体|文字|text|MEDIA/i);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_execution_permits').get().n,0);
 const real=new UnifiedExecutor(f.publisher,{...f.options,drivers:{create:async()=>{throw Error('MUST_NOT_CALL');}}});assert.equal(real.executionCapability(f.scope.workspace,j.id).reason,'PRODUCTION_PREVIEW_ONLY_NO_PUBLISH_AUTHORITY');assert.equal(observePublicationAuthority(real,f.scope.workspace,f.scope.accountId,j.id).eligible,false);assert.equal(f.factory.stats().submits,0);
});
