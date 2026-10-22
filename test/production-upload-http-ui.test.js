import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../src/server.js';
import {PublisherAccess} from '../src/publisher-access.js';
import {handoffFixture} from './fixtures/production-handoff.js';

async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'v3-upload-http-')),f=await handoffFixture(root,{video:true}),cloud={mode:'cloud',executionConnected:false,origin:'http://127.0.0.1:0',host:'127.0.0.1:0',user:'synthetic-admin',password:'synthetic-disposable-test-password',dataDir:root};let driverCalls=0;
 const app=createApp(f.demo.dbPath,{unified:true,cloud,executionEnabled:false,scanScheduler:false,drivers:{create:async()=>{driverCalls++;throw Error('NO_EXTERNAL_ADAPTER');}}});await new Promise(r=>app.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.address().port;cloud.origin=origin;cloud.host=new URL(origin).host;
 t.after(async()=>{await new Promise(r=>app.close(r));f.store.close();rmSync(root,{recursive:true,force:true});});return {...f,cloud,app,origin,driverCalls:()=>driverCalls};
}

test('upload-plan transport retains existing admin/Origin/CSRF/app scopes and exact binding; real execution is denied',async t=>{
 const f=await setup(t),auth={Authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')},scope=new URLSearchParams(f.scope),url=f.origin+'/api/production-reviews/'+f.reviewId+'/upload-plan?'+scope,state=await(await fetch(f.origin+'/api/state?workspace='+f.scope.workspace,{headers:auth})).json(),headers={...auth,Origin:f.origin,'X-Local-Token':state.token,'Content-Type':'application/json'},post=(body=f.input,extra={},target=url)=>fetch(target,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);assert.equal((await post(f.input,{'X-Local-Token':'wrong'})).status,409);assert.equal((await post(f.input,{Origin:'https://unrelated.invalid'})).status,409);assert.equal((await post({...f.input,publish_allowed:true})).status,409);
 assert.equal(new PublisherAccess(f.cloud).authorizeApp({type:'app',token:{workspaces:[f.scope.workspace],scopes:['content:import','jobs:create','jobs:read']}},'POST',new URL(url)),false);
 const response=await post();assert.equal(response.status,200);const plan=await response.json();assert.equal(plan.publish_allowed,false);assert.equal((await(await post()).json()).job_id,plan.job_id);
 const job=f.publisher.job(f.scope.workspace,plan.job_id),base=f.origin+'/api/unified/workspaces/'+f.scope.workspace+'/jobs/'+job.id;assert.equal((await post({snapshot_hash:job.snapshot_hash},{},base+'/approve')).status,409);assert.equal((await post({},{},base+'/execute')).status,409);
 const visible=await(await fetch(f.origin+'/api/facebook?workspace='+f.scope.workspace,{headers:auth})).json();assert.equal(visible.groupContent.length,1);assert.ok(visible.groupContent[0].production_preview);
 f.publisher.selectAccount(f.scope.workspace,f.demo.secondAccountId);const other=await(await fetch(f.origin+'/api/facebook?workspace='+f.scope.workspace,{headers:auth})).json();assert.equal(other.groupContent.length,0);
 assert.equal((await post(f.input,{},f.origin+'/api/production-reviews/'+f.reviewId+'/upload-plan?'+new URLSearchParams({workspace:f.demo.otherWorkspace,accountId:f.demo.otherAccountId}))).status,409);
 const report=await(await fetch(f.origin+'/api/publication-verification?'+scope,{headers:auth})).json();assert.equal(report.rows[0].verification_status,'SYNTHETIC_ONLY');assert.equal(report.summary.published,0);assert.equal(f.driverCalls(),0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,0);
});

for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('original '+name+' Review -> upload preparation -> original platform preview plays the exact extracted video',{timeout:40000},async t=>{
 const f=await setup(t);let browser;try{
  browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext({viewport}),outside=[],errors=[],writes=[];
  await context.route('**/*',r=>new URL(r.request().url()).origin===f.origin?r.continue():(outside.push(r.request().url()),r.abort()));const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  await page.goto(f.origin);await page.getByLabel('用户名',{exact:true}).fill(f.cloud.user);await page.getByLabel('密码',{exact:true}).fill(f.cloud.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('#ws').selectOption(f.scope.workspace);await page.locator('[data-route="production-review"]').click();await page.locator('[data-production-review="'+f.reviewId+'"] > summary').click();await page.locator('[data-approval-state="CONTENT_APPROVED"]').waitFor();
  await page.locator('[data-production-upload]').dblclick();await page.locator('[data-production-upload-status]').filter({hasText:'已冻结上传输入'}).waitFor();assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_upload_plans').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);
  await page.getByRole('button',{name:'查看原内容与平台预览',exact:true}).click();await page.locator('#unified-jobs > article').waitFor();assert.match(await page.locator('#unified-jobs').innerText(),/非真实发布/);assert.equal(await page.locator('#unified-jobs [data-approve],#unified-jobs [data-approve-auto]').count(),0);assert.match(await page.locator('#unified-payload-body').inputValue(),/Synthetic video platform copy/);assert.equal(await page.locator('#unified-payload-body').isDisabled(),true);assert.equal(await page.locator('#unified-create').isDisabled(),true);assert.match(await page.locator('#unified-create-reason').innerText(),/不授予发布权限/);
  await page.locator('#unified-preview').click();const dialog=page.getByRole('dialog');await dialog.locator('video').evaluate(v=>{v.load();return new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(Error('VIDEO_PREVIEW_FAILED'));});});assert.equal(await dialog.locator('video').evaluate(v=>v.videoWidth),320);await dialog.locator('video').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('dialog video')?.ended);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));if(process.env.V3_HANDOFF_EVIDENCE_DIR){mkdirSync(process.env.V3_HANDOFF_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.V3_HANDOFF_EVIDENCE_DIR,name+'-native-video-preview.png')});}
  await page.keyboard.press('Escape');await page.reload();await page.locator('#unified-content option').waitFor({state:'attached'});assert.equal(f.publisher.list(f.scope.workspace,f.scope.accountId)[0].state,'DRAFT');assert.equal(f.driverCalls(),0);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);assert.ok(writes.every(p=>p==='/auth/login'||p.endsWith('/upload-plan')));assert.equal(writes.filter(p=>p.endsWith('/upload-plan')).length,1);
 }finally{await browser?.close();}
});
