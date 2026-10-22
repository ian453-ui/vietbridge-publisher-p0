import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../src/server.js';
import {PublisherAccess} from '../src/publisher-access.js';
import {handoffFixture} from './fixtures/production-handoff.js';
import {trustedSourceFixture} from './fixtures/trusted-production-source.js';

async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'v3-source-http-')),f=await handoffFixture(root),source=trustedSourceFixture(f),cloud={mode:'cloud',executionConnected:false,origin:'http://127.0.0.1:0',host:'127.0.0.1:0',user:'synthetic-admin',password:'synthetic-disposable-test-password',dataDir:root};let driverCalls=0;
 const app=createApp(f.demo.dbPath,{unified:true,cloud,executionEnabled:false,scanScheduler:false,productionSourceEvidence:source.options,drivers:{create:async()=>{driverCalls++;throw Error('NO_EXTERNAL_ADAPTER');}}});await new Promise(r=>app.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.address().port;cloud.origin=origin;cloud.host=new URL(origin).host;
 t.after(async()=>{await new Promise(r=>app.close(r));f.store.close();rmSync(root,{recursive:true,force:true});});return {...f,source,cloud,app,origin,driverCalls:()=>driverCalls};
}
test('verify-source HTTP uses existing admin/Origin/CSRF guard, no new app scopes; only server provider can supply evidence',async t=>{
 const f=await setup(t),auth={Authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')},scope=new URLSearchParams(f.scope),url=f.origin+'/api/production-reviews/'+f.reviewId+'/verify-source?'+scope,state=await(await fetch(f.origin+'/api/state?workspace='+f.scope.workspace,{headers:auth})).json(),headers={...auth,Origin:f.origin,'X-Local-Token':state.token,'Content-Type':'application/json'},body={expected_subject:f.source.expected.binding.subject_fingerprint},post=(input=body,extra={},target=url)=>fetch(target,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(input)});
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);assert.equal((await post(body,{'X-Local-Token':'wrong'})).status,409);assert.equal((await post(body,{Origin:'https://unrelated.invalid'})).status,409);
 assert.equal((await post({...body,authenticated:true})).status,409);assert.equal((await post({...body,source_evidence:f.source.snapshot})).status,409);assert.equal(f.source.calls,0);
 assert.equal(new PublisherAccess(f.cloud).authorizeApp({type:'app',token:{workspaces:[f.scope.workspace],scopes:['content:import','jobs:create','jobs:read']}},'POST',new URL(url)),false);
 const response=await post();assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.current.status,'VERIFIED');assert.equal(receipt.producer_authenticated,false);assert.equal(receipt.publish_allowed,false);assert.equal(f.source.calls,1);
 const detail=await(await fetch(f.origin+'/api/production-reviews/'+f.reviewId+'?'+scope,{headers:auth})).json();assert.equal(detail.source_verification.status,'VERIFIED');assert.equal(detail.approval.state,'REVOKED');assert.equal(detail.approval.can_decide,true);assert.equal(detail.source_verification.decision.kind,'APPROVED');assert.equal(JSON.stringify(detail).includes('original-task-owner'),false,'source identity/raw evidence not exposed');
 assert.equal((await post(body,{},f.origin+'/api/production-reviews/'+f.reviewId+'/verify-source?'+new URLSearchParams({workspace:f.demo.otherWorkspace,accountId:f.demo.otherAccountId}))).status,409);assert.equal(f.source.calls,1);assert.equal(f.driverCalls(),0);
});

for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test(name+' original Review reads trusted test evidence, persists explicit human approval, then revokes on newer source QA',{timeout:40000},async t=>{
 const f=await setup(t);let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext({viewport}),outside=[],errors=[],writes=[];
  await context.route('**/*',r=>new URL(r.request().url()).origin===f.origin?r.continue():(outside.push(r.request().url()),r.abort()));const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  await page.goto(f.origin);await page.getByLabel('用户名',{exact:true}).fill(f.cloud.user);await page.getByLabel('密码',{exact:true}).fill(f.cloud.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('#ws').selectOption(f.scope.workspace);await page.locator('[data-route="production-review"]').click();await page.locator('[data-production-review="'+f.reviewId+'"] > summary').click();
  const section=page.locator('[data-production-review="'+f.reviewId+'"]');await section.locator('[data-source-verification="BLOCKED"]').waitFor();assert.equal(await section.locator('[data-production-decide]').count(),0);
  await section.getByRole('button',{name:'读取来源审批证据',exact:true}).click();await section.locator('[data-source-verification="VERIFIED"]').waitFor();for(const input of await section.locator('[data-production-check],[data-content-only]').all())await input.check();await section.locator('[data-production-decide="APPROVE"]').click();await section.locator('[data-approval-state="CONTENT_APPROVED"]').waitFor();assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_approval_source_bindings').get().n,1);
  if(process.env.V3_SOURCE_EVIDENCE_DIR){mkdirSync(process.env.V3_SOURCE_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.V3_SOURCE_EVIDENCE_DIR,name+'-source-approved.png'),fullPage:true});}
  f.source.revoke();await section.getByRole('button',{name:'读取来源审批证据',exact:true}).click();await section.locator('[data-source-verification="BLOCKED"]').waitFor();await section.locator('[data-approval-state="REVOKED"]').waitFor();assert.match(await section.innerText(),/SOURCE_APPROVAL_REVOKED/);assert.equal(await section.locator('[data-production-upload]').count(),0);
  await page.reload();await page.locator('[data-route="production-review"]').click();await page.locator('[data-production-review="'+f.reviewId+'"] > summary').click();await section.locator('[data-approval-state="REVOKED"]').waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(f.driverCalls(),0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);assert.ok(writes.every(p=>p==='/auth/login'||p.endsWith('/verify-source')||p.endsWith('/decision')));
 }finally{await browser?.close();}
});
