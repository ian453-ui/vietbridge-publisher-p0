import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {setup} from './helpers/scoped-fixture.js';
import {cloudFor} from './helpers/scoped-wrapper-fixture.js';
import {runtime,mockClient} from './helpers/browser-skill-fixture.js';
import {createControlledApp} from '../maintenance/controlled-app.mjs';
import {createApp} from '../src/server.js';
import {scopeDigest} from '../src/task-action-permit.js';
import {BrowserResources} from '../src/browser-resources.js';

test('one controlled normal UI: bounded settings -> group opt-in -> scan -> rules/confirmation -> original permit -> readback; frozen009 retained',async t=>{
 const f=setup(t),b=runtime(f),group=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Approved help group',url:'https://www.facebook.com/groups/12345/'}),source={permalink:'https://www.facebook.com/groups/12345/posts/56789/',body:'我们公司在越南工厂招聘很慢，请问大家如何改善面试到岗率？'},client=mockClient(b,source);
 f.store.db.prepare("UPDATE facebook_accounts SET session_health='HEALTHY' WHERE id=?").run(f.account.id);f.store.ensureProactiveAccount(f.w.id,f.account.id);f.publisher.selectAccount(f.w.id,f.account.id);f.store.selectAccount(f.w.id,f.account.id);
 const old=f.makePage('Frozen 009 never retried');f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='preserved-009' WHERE id=?").run(old.id);const release=f.executor.resources.acquire(f.profile.user_data_dir,'operator:'+f.profile.id,()=>true);release();
 const lease=join(f.root,'locks',readdirSync(join(f.root,'locks'))[0],'owner.json'),beforeLease=readFileSync(lease),beforeJob=JSON.stringify(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id)),s={version:1,workspace:b.workspace,account_id:b.account_id,actor_id:b.actor_id,target_page_id:b.target_page_id,issued_at:b.issued_at,expires_at:b.expires_at,max_groups:2,max_daily_actions:3,max_followups:5};
 const config={version:1,scopeAuthorization:{...f.policy,profile_id:'bsk:e91ba5d3',operations:['INTERACTION']},browserSkillBinding:b,operatingSettingsScope:s,interactionFlow:{version:1,group_ids:[group.id]},targets:[]},cloud=cloudFor(f),server=createControlledApp(createApp,f.dbPath,{config,head:'a'.repeat(40),scopeDigest,cloud,browserSkillClient:client,library:{roots:[f.root],snapshotRoot:f.root,gptInboxBase:null},drivers:f.executor.drivers});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;const errors=[],outside=[],writes=[];
 try{
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext();await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(outside.push(r.request().url()),r.abort()));const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill(cloud.user);await page.getByLabel('密码',{exact:true}).fill(cloud.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('#ws').selectOption(f.w.id);await page.locator('[data-route="proactive"]').click();
  await page.locator('#proactive-enabled').check();await page.locator('#proactive-auto-reply').check();await page.locator('#proactive-topics').fill('越南工厂,招聘');await page.locator('#save-proactive').click();await page.getByText('主动互动设置已保存；未执行任何 Facebook 写操作。',{exact:true}).waitFor();
  assert.equal(client.submits,0);assert.equal(client.calls.length,0);await page.locator(`[data-proactive-group="${group.id}"]`).check();await page.locator('#save-proactive-groups').click();await page.getByText(/已保存 1 个群组开关/).waitFor();await page.locator('#scan-proactive:not([disabled])').waitFor();await page.locator('#scan-proactive').click();await page.getByText(/扫描完成：/).waitFor();
  const post=f.store.db.prepare('SELECT * FROM engagement_posts WHERE account_id=?').get(f.account.id);assert.ok(post);assert.equal(post.classification,'VALID');assert.equal(client.submits,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permits').get().n,0);
  const reply='先统计邀约、面试、到岗各环节，再核对主要流失原因。';await page.locator(`[data-proactive-reply="${post.id}"]`).fill(reply);await page.locator(`[data-execute-proactive="${post.id}"]`).click();await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').locator('[data-submit]').isDisabled(),true);await page.keyboard.press('Escape');assert.equal(client.submits,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permits').get().n,0);
  await page.locator(`[data-execute-proactive="${post.id}"]`).click();await page.getByRole('dialog').locator('[data-group-rules]').check();await page.getByRole('dialog').locator('[data-submit]').click();await page.getByText('互动已完成独立页面回读；详情已写入执行记录。',{exact:true}).waitFor();
  assert.equal(client.submits,1);const action=f.store.db.prepare('SELECT * FROM engagement_actions WHERE post_id=?').get(post.id);assert.equal(action.state,'CONFIRMED');assert.equal(JSON.parse(action.evidence_json).comment_id,'12399');assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,1);assert.equal(f.store.db.prepare('SELECT status FROM task_action_permits').get().status,'CONSUMED');
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id)),beforeJob);assert.deepEqual(readFileSync(lease),beforeLease);assert.equal(f.creates,0);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  const routeCounts=Object.fromEntries([...new Set(writes)].map(p=>[p,writes.filter(x=>x===p).length]));assert.equal(routeCounts[`/api/workspaces/${f.w.id}/proactive/posts/${post.id}/execute`],1);assert.equal(writes.some(p=>/reconcile|diagnostics|launch|auto-publish/.test(p)),false);
  const health=await page.request.get(origin+'/api/health');const hv=await health.json();assert.equal(hv.executionEnabled,false);assert.equal(hv.scanSchedulerEnabled,false);
 }finally{await browser?.close();await new Promise(r=>{server.once('storage-closed',r);server.close();});}
});
test('all BSK entrypoints share canonical durable instance lock: ACTIVE/PENDING/restart block second operator; legacy bytes unchanged',t=>{
 const f=setup(t),legacy=f.executor.resources.acquire(f.profile.user_data_dir,'legacy',()=>true);legacy();const oldFile=join(f.root,'locks',readdirSync(join(f.root,'locks'))[0],'owner.json'),oldBytes=readFileSync(oldFile),a=new BrowserResources(join(f.root,'locks')),b=new BrowserResources(join(f.root,'locks'));
 const release=a.acquireInstance('e91ba5d3','new-interaction',()=>true);assert.throws(()=>b.acquireInstance('e91ba5d3','scan',()=>false));release();assert.throws(()=>new BrowserResources(join(f.root,'locks')).acquireInstance('e91ba5d3','new-interaction',()=>false));assert.throws(()=>b.acquireInstance('VISA','scan',()=>false));assert.deepEqual(readFileSync(oldFile),oldBytes);
});
test('removed physicalIdentity option cannot split the same legacy resource into a second lock in either direction',t=>{
 const f=setup(t),resources=f.executor.resources,old=resources.acquire(f.root,'old-path',()=>false);
 assert.throws(()=>resources.acquire(f.root,'old-physical-key',()=>false,{physicalIdentity:{device:'fake',inode:'fake'}}));old();
 const reverse=resources.acquire(f.root,'old-physical-key',()=>true,{physicalIdentity:{device:'fake',inode:'fake'}});assert.throws(()=>resources.acquire(f.root,'old-path',()=>false));reverse();assert.throws(()=>new BrowserResources(join(f.root,'locks')).acquire(f.root,'old-path',()=>false));
});
