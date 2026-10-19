import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup} from './helpers/scoped-fixture.js';
import {InteractiveScopedOperations} from '../src/interactive-scoped-operations.js';

function history(root){const path=join(root,'v1.sqlite'),events=join(root,'events.jsonl'),verified=join(root,'verified.jsonl'),yaml=join(root,'ledger.yaml');const db=new DatabaseSync(path);db.exec('CREATE TABLE jobs(job_id TEXT,article_id TEXT,platform TEXT,account_id TEXT,state TEXT,current_attempt_id TEXT,submitted_at TEXT,published_at TEXT,updated_at TEXT);CREATE TABLE facebook_accounts(id TEXT,page_id TEXT);CREATE TABLE platform_attempts(job_id TEXT,started_at TEXT);CREATE TABLE platform_receipts(job_id TEXT,raw_status TEXT);CREATE TABLE content_snapshots(article_id TEXT,canonical_payload_json TEXT)');db.close();writeFileSync(events,'');writeFileSync(verified,'');writeFileSync(yaml,'published_history: {}\n');return [{kind:'V1',path,ledger_paths:{events:[events,verified],yaml}}];}
const reviewed='群规已核对：允许与越南企业运营有关的原创图文，禁止广告链接和重复发布。';

test('normal UI can grant only its exact group task after frozen preview and rules review',t=>{
 const f=setup(t),group=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Joined group',url:'https://www.facebook.com/groups/12345/'}),content=f.store.createContent(f.w.id,{body:'Original group help',media:[]}),[job]=f.store.createGroupJobs(f.w.id,{account_id:f.account.id,content_id:content.id,group_ids:[group.id]});
 const ui=new InteractiveScopedOperations(f.executor,f.facebook,{accountId:f.account.id,additionalHistory:history(f.root),mediaRoots:[f.root],snapshotRoot:join(f.root,'snapshots')});
 const cap=ui.capability('GROUP',job.id);assert.equal(cap.canExecute,true,cap.reason);assert.equal(cap.preview.groupUrl,group.url);assert.equal(cap.preview.body,content.body);assert.equal(cap.requiresRulesSummary,true);
 const auth={task_id:`publisher-ui:GROUP:${job.id}`,approval_thread_id:'authenticated-admin:test-session',approval_message_id:'ui-confirm:test-click'};
 assert.throws(()=>f.store.beginPrepare(f.w.id,job.id,'LP',attempt=>ui.make('GROUP',job.id,undefined,auth).confirmAndConsume('GROUP',job.id,{confirm:true,scope_hash:cap.scopeHash,ack_group_rules:true},attempt)),/REVIEWED_GROUP_RULES_SUMMARY_REQUIRED/);
 assert.equal(f.store.job(f.w.id,job.id).state,'PENDING');
 f.store.beginPrepare(f.w.id,job.id,'LP',attempt=>ui.make('GROUP',job.id,undefined,auth).confirmAndConsume('GROUP',job.id,{confirm:true,scope_hash:cap.scopeHash,ack_group_rules:true,group_rules_summary:reviewed},attempt));
 const permit=f.store.db.prepare("SELECT * FROM task_action_permits WHERE subject_id=?").get('GROUP:'+job.id);assert.equal(permit.status,'CONSUMED');assert.equal(JSON.parse(permit.authorization_json).confirmation.group_rules_summary,reviewed);assert.equal(f.store.job(f.w.id,job.id).attempt_id,permit.attempt_id);
 assert.equal(ui.capability('GROUP',job.id).canExecute,false);
});

test('normal UI interaction is scoped to joined opted-in group and reviewed reply',t=>{
 const f=setup(t),group=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Help group',url:'https://www.facebook.com/groups/12345/',proactive_engagement_enabled:true});f.store.db.prepare("UPDATE facebook_accounts SET session_health='HEALTHY' WHERE id=?").run(f.account.id);f.store.saveProactiveSettings(f.w.id,{account_id:f.account.id,enabled:true,auto_like:true,auto_reply:true,project_topics:'越南工厂,招聘'});
 const [post]=f.store.ingestEngagementPosts(f.w.id,f.account.id,[{group_id:group.id,external_id:'56789',permalink:'https://www.facebook.com/groups/12345/posts/56789/',author:'Author',body:'我们公司在越南工厂招聘很慢，请问大家如何改善面试到岗率？'}]);const reply='记录邀约、面试和到岗各环节，定位流失。';
 const ui=new InteractiveScopedOperations(f.executor,f.facebook,{accountId:f.account.id,additionalHistory:history(f.root),mediaRoots:[f.root],snapshotRoot:join(f.root,'snapshots')});const cap=ui.capability('INTERACTION',post.id,reply);assert.equal(cap.canExecute,true,cap.reason);assert.equal(cap.preview.groupUrl,group.url);assert.deepEqual(cap.actionScope.actions,['LIKE','INITIAL_REPLY']);
 const auth={task_id:`publisher-ui:INTERACTION:${post.id}`,approval_thread_id:'authenticated-admin:test-session',approval_message_id:'ui-confirm:test-click'};
 f.store.reserveProactivePost(f.w.id,post.id,reply,{scope_hash:f.store.proactiveScopeHash(f.w.id,post.id,reply)},()=>{const attempt='interaction-test-attempt';ui.make('INTERACTION',post.id,reply,auth).confirmAndConsume('INTERACTION',post.id,{confirm:true,scope_hash:cap.scopeHash,reply_body:reply,ack_group_rules:true,group_rules_summary:reviewed},attempt);return attempt;});
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM task_action_daily_claims WHERE kind='INTERACTION'").get().n,2);assert.equal(ui.capability('INTERACTION',post.id,reply).canExecute,false);
 const foreign={kind:'INTERACTION',subject_id:'INTERACTION:foreign-post',workspace:'foreign-workspace',account_id:'foreign-account',transport:'BROWSER'};f.store.db.prepare('INSERT INTO task_action_permits VALUES(?,?,?,?,?,?,?,?,?)').run('foreign-interaction-permit',foreign.subject_id,JSON.stringify(foreign),'0'.repeat(64),'{}','CONSUMED',Date.now(),Date.now()+3600000,'foreign-attempt');
 assert.deepEqual(f.store.db.prepare('SELECT state FROM engagement_actions WHERE post_id=?').all(post.id).map(r=>r.state),['ATTEMPTING','ATTEMPTING']);ui.recoverStartup();
 assert.deepEqual(f.store.db.prepare('SELECT state FROM engagement_actions WHERE post_id=?').all(post.id).map(r=>r.state),['RECONCILE_PENDING','RECONCILE_PENDING']);assert.equal(f.store.proactivePost(f.w.id,post.id).state,'RECONCILE_PENDING');assert.equal(f.store.db.prepare("SELECT status FROM task_action_permits WHERE subject_id=?").get('INTERACTION:'+post.id).status,'CONSUMED');assert.equal(f.store.db.prepare("SELECT status FROM task_action_permits WHERE id='foreign-interaction-permit'").get().status,'CONSUMED');assert.equal(f.store.db.prepare("SELECT count(*) n FROM task_action_daily_claims WHERE kind='INTERACTION'").get().n,2);
});
test('interactive group single-submit adapter consumes permit before its mocked browser call',async t=>{
 const f=setup(t),group=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Joined group',url:'https://www.facebook.com/groups/12345/'}),content=f.store.createContent(f.w.id,{body:'One reviewed group body',media:[]}),[job]=f.store.createGroupJobs(f.w.id,{account_id:f.account.id,content_id:content.id,group_ids:[group.id]});
 const ui=new InteractiveScopedOperations(f.executor,f.facebook,{accountId:f.account.id,additionalHistory:history(f.root),mediaRoots:[f.root],snapshotRoot:join(f.root,'snapshots')});const cap=ui.capability('GROUP',job.id),auth={task_id:`publisher-ui:GROUP:${job.id}`,approval_thread_id:'authenticated-admin:test-session',approval_message_id:'ui-confirm:test-click'};let browserCalls=0;
 f.facebook.connectPage=async()=>({browser:{close:async()=>{}}});f.facebook.publishJob=async(workspace,id,{assertScoped})=>{assertScoped();browserCalls++;f.store.finishPrepare(workspace,id,{target_url:group.url});f.store.beginSubmit(workspace,id,{body:content.body});return f.store.claimPost(workspace,id,'https://www.facebook.com/groups/12345/posts/54321/',{method:'AUTO_POST_BROWSER_READBACK'});};
 const result=await ui.executeGroup(f.w.id,job.id,{confirm:true,scope_hash:cap.scopeHash,ack_group_rules:true,group_rules_summary:reviewed},auth);assert.equal(result.state,'PUBLISHED');assert.equal(browserCalls,1);assert.equal(f.store.db.prepare("SELECT status FROM task_action_permits WHERE subject_id=?").get('GROUP:'+job.id).status,'CONSUMED');await assert.rejects(()=>ui.executeGroup(f.w.id,job.id,{confirm:true,scope_hash:cap.scopeHash,ack_group_rules:true,group_rules_summary:reviewed},auth));assert.equal(browserCalls,1);
});
