import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright-core';
import {createApp} from '../src/server.js';
import {PublisherAccess} from '../src/publisher-access.js';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {v3ReviewDemo} from '../scripts/v3-review-demo.mjs';
import {seedSyntheticApproval,approvalCommand} from './fixtures/synthetic-approval.js';

function fixture(root){const demo=v3ReviewDemo(join(root,'demo')),db=new DatabaseSync(demo.dbPath),reviews=new ProductionReviewStore(db),scope={workspace:demo.workspace,accountId:demo.accountId};seedSyntheticApproval(reviews,demo.id,scope);return {demo,db,reviews,scope};}
test('decision transport uses existing admin/Origin/token/JSON guard; unverified producer and invented auth are blocked',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-approval-http-')),f=fixture(root),cloud={mode:'cloud',executionConnected:false,origin:'https://fixture.invalid',host:'fixture.invalid',user:'synthetic-admin',password:'synthetic-disposable-test-password',dataDir:root};let deny=false,guards=0;
 const app=createApp(f.demo.dbPath,{unified:true,cloud,requestGuard:()=>{guards++;if(deny)throw Error('SYNTHETIC_EXISTING_GUARD_DENIAL');}});t.after(()=>{app.emit('close');f.db.close();rmSync(root,{recursive:true,force:true});});
 const auth={authorization:'Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64')},query=new URLSearchParams(f.scope),path='/api/production-reviews/'+f.demo.id,call=async(url,{headers={},method='GET',body}={})=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url,method,headers:{host:cloud.host,...headers}});let status=200,bodyOut;const res={setHeader(){},writeHead(s){status=s;},end(b){bodyOut=b;}};await app.listeners('request')[0](req,res);return {status,body:bodyOut?JSON.parse(bodyOut):null};};
 const state=await call('/api/state?workspace='+f.demo.workspace,{headers:auth}),headers={...auth,origin:cloud.origin,'x-local-token':state.body.token,'content-type':'application/json'},read=await call(path+'?'+query,{headers:auth}),command=approvalCommand(read.body.approval),url=path+'/decision?'+query;
 assert.equal((await call(url,{method:'POST',body:command})).status,401);
 for(const wrong of [{origin:'https://unrelated.invalid'},{'x-local-token':'wrong'},{'content-type':'text/plain'}])assert.equal((await call(url,{method:'POST',headers:{...headers,...wrong},body:command})).status,409);
 assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,0);deny=true;assert.match((await call(url,{method:'POST',headers,body:command})).body.error,/EXISTING_GUARD_DENIAL/);deny=false;
 const saved=await call(url,{method:'POST',headers,body:command});assert.equal(saved.status,200);assert.equal(saved.body.approval.state,'CONTENT_APPROVED');assert.equal((await call(url,{method:'POST',headers,body:command})).body.status,'DUPLICATE');assert.ok(guards>=3);
 assert.equal(new PublisherAccess(cloud).authorizeApp({type:'app',token:{workspaces:[f.demo.workspace],scopes:['jobs:read','content:import','jobs:create']}},'POST',new URL(url,cloud.origin)),false);
 assert.match((await call(url,{method:'POST',headers,body:{...command,producer_authenticated:true}})).body.error,/COMMAND_INVALID/);
 const otherQuery=new URLSearchParams({workspace:f.demo.otherWorkspace,accountId:f.demo.otherAccountId});assert.match((await call(path+'/decision?'+otherQuery,{method:'POST',headers,body:command})).body.error,/NOT_FOUND/);
 f.db.prepare('DELETE FROM production_review_provenance WHERE review_id=?').run(f.demo.id);assert.match((await call(url,{method:'POST',headers,body:command})).body.error,/PRODUCER_AUTH_UNAVAILABLE/);assert.equal((await call(path+'?'+query,{headers:auth})).body.approval.can_decide,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
});

test('unauthenticated local preview cannot acquire approval authority from the local request token',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-approval-local-')),f=fixture(root),app=createApp(f.demo.dbPath,{unified:true});t.after(()=>{f.db.close();rmSync(root,{recursive:true,force:true});});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.address().port;try{const state=await (await fetch(origin+'/api/state?workspace='+f.demo.workspace)).json(),view=f.reviews.approvals.view(f.demo.id,f.scope,{admin:true}),response=await fetch(origin+'/api/production-reviews/'+f.demo.id+'/decision?'+new URLSearchParams(f.scope),{method:'POST',headers:{Origin:origin,'X-Local-Token':state.token,'Content-Type':'application/json'},body:JSON.stringify(approvalCommand(view))});assert.equal(response.status,403);assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,0);}finally{await new Promise(r=>app.close(r));}
});

test('authenticated original Review UI approves/rejects synthetic content, reads durable receipts and ignores stale scope responses',{timeout:40000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'v3-approval-browser-')),f=fixture(root),cloud={mode:'cloud',executionConnected:false,origin:'http://127.0.0.1:0',host:'127.0.0.1:0',user:'synthetic-admin',password:'synthetic-disposable-test-password',dataDir:root},app=createApp(f.demo.dbPath,{unified:true,executionEnabled:false,cloud});let browser,release;
 try{
  await new Promise(r=>app.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.address().port;cloud.origin=origin;cloud.host=new URL(origin).host;
  browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext(),outside=[],errors=[],writes=[];
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(outside.push(r.request().url()),r.abort()));const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill(cloud.user);await page.getByLabel('密码',{exact:true}).fill(cloud.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  const open=async()=>{await page.locator('#ws').selectOption(f.demo.workspace);await page.locator('[data-route="production-review"]').click();await page.locator('[data-production-review] > summary').click();await page.locator('[data-production-approval]').waitFor();};await open();
  for(const tab of ['v1','verification','groups','inbox','engagement','proactive','settings'])assert.equal(await page.locator('[data-route="'+tab+'"]').count(),1);
  const approve=async()=>{for(const checkbox of await page.locator('[data-production-check]').all())await checkbox.check();await page.locator('[data-content-only]').check();await page.locator('[data-approval-reason]').fill('Synthetic browser review only');await page.locator('[data-production-decide="APPROVE"]').dblclick();};
  assert.equal(await page.locator('[data-production-decide="APPROVE"]').isDisabled(),true);await approve();await page.locator('[data-approval-state="CONTENT_APPROVED"]').waitFor();await page.getByText('决定已保存并回读；没有创建发布任务。',{exact:true}).waitFor();
  assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,1);if(process.env.V3_APPROVAL_SCREENSHOT)await page.locator('[data-production-approval]').screenshot({path:process.env.V3_APPROVAL_SCREENSHOT});
  await page.locator('[data-approval-reason]').fill('Synthetic subtitle revision required');await page.locator('[data-content-only]').check();await page.locator('[data-production-decide="REJECT"]').click();await page.locator('[data-approval-state="CONTENT_REJECTED"]').waitFor();await page.reload();await open();await page.locator('[data-approval-state="CONTENT_REJECTED"]').waitFor();
  let ready;const held=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('APPROVAL_DELAY_NOT_REACHED')),7000);ready=()=>{clearTimeout(timer);resolve();};});
  await page.route('**/api/production-reviews/*/decision?*',async route=>{const response=await route.fetch(),gate=new Promise(r=>release=r);ready();await gate;await route.fulfill({response});});
  for(const checkbox of await page.locator('[data-production-check]').all())await checkbox.check();await page.locator('[data-content-only]').check();await page.locator('[data-production-decide="APPROVE"]').click();await held;
  await page.locator('#ws').selectOption(f.demo.otherWorkspace);await page.waitForFunction(()=>document.getElementById('production-reviews')?.textContent.includes('暂无'));release();await page.waitForTimeout(150);assert.equal(await page.locator('[data-production-approval]').count(),0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,3);assert.equal(f.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);assert.equal(writes.filter(p=>p.endsWith('/decision')).length,3);assert.ok(writes.every(p=>p==='/auth/login'||p.endsWith('/decision')||p==='/api/unified/workspaces/'+f.demo.workspace+'/accounts/select'));assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
 }finally{release?.();await browser?.close();await new Promise(r=>app.close(r));f.db.close();rmSync(root,{recursive:true,force:true});}
});
