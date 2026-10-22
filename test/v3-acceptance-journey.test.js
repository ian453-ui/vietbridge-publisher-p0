import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright-core';
import {createApp} from '../src/server.js';
import {v3AcceptanceDemo} from '../scripts/v3-acceptance-demo.mjs';

for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('V3 bounded acceptance '+name+': retained context/tasks/preview and ZIP-review-metrics',{timeout:60000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'v3-acceptance-')),demo=await v3AcceptanceDemo(join(root,'demo'));
 // Disposable existing-admin fixture. The connection flag exposes local preparation only;
 // execution and scheduling stay off and an injected adapter fails if ever constructed.
 let adapterCalls=0;const cloud={mode:'mac-tunnel',executionConnected:true,origin:'http://127.0.0.1:0',host:'127.0.0.1:0',user:'synthetic-admin',password:'synthetic-disposable-test-password',dataDir:root};
 const app=createApp(demo.dbPath,{unified:true,cloud,executionEnabled:false,scanScheduler:false,library:{roots:[demo.libraryRoot],snapshotRoot:demo.snapshotRoot,gptInboxBase:null},drivers:{create:async()=>{adapterCalls++;throw Error('ACCEPTANCE_NO_PLATFORM_ADAPTER');}}});let browser;
 try{
  await new Promise(r=>app.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.address().port;cloud.origin=origin;cloud.host=new URL(origin).host;
  browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext({viewport}),external=[],errors=[],writes=[],steps=[];
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(external.push(r.request().url()),r.abort()));
  const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET')writes.push(new URL(r.url()).pathname);});
  const evidence=process.env.V3_ACCEPTANCE_EVIDENCE_DIR;if(evidence)mkdirSync(evidence,{recursive:true});
  const capture=async label=>{if(evidence)await page.screenshot({path:join(evidence,name+'-'+label+'.png'),fullPage:false});};
  const width=async()=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page must fit viewport; individual scrollable panels remain allowed');assert.ok(await page.locator('#production-reviews,#metric-observations').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)),'review text, hashes and metric evidence must wrap within their panel');};
  await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill(cloud.user);await page.getByLabel('密码',{exact:true}).fill(cloud.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('#ws').selectOption(demo.workspace);await page.locator('#unified-content').selectOption(demo.contentIds[0]);await page.waitForFunction(()=>document.querySelectorAll('#unified-jobs > article').length===2);
  assert.match(await page.locator('#unified-payload-body').inputValue(),/END-SYNTHETIC-20261020-074-TRADE/);
  await page.locator('#unified-preview').click();const dialog=page.getByRole('dialog');assert.match(await dialog.innerText(),/END-SYNTHETIC-20261020-074-TRADE/);await dialog.locator('img').evaluate(i=>i.decode());assert.ok(await dialog.locator('img').evaluate(i=>i.naturalWidth>0));await width();await capture('legacy-preview');await page.keyboard.press('Escape');
  await page.locator('#unified-content').selectOption(demo.contentIds[1]);assert.match(await page.locator('#unified-payload-body').inputValue(),/END-SYNTHETIC-20261021-074-PERMIT/);assert.doesNotMatch(await page.locator('#unified-payload-body').inputValue(),/TRADE/);
  await page.locator('#unified-platform').selectOption('xiaohongshu');await page.getByLabel('发布账号',{exact:true}).selectOption(demo.secondAccountId);await page.locator('#unified-target-identity').filter({hasText:'Synthetic same-customer'}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('#unified-jobs > article').length===1);await page.locator('#unified-content').selectOption(demo.contentIds[1]);assert.equal(await page.locator('#unified-create').isDisabled(),true);assert.match(await page.locator('#unified-create-reason').innerText(),/尚无该平台公开文案/);await page.locator('#unified-content').selectOption(demo.xhsContentId);assert.match(await page.locator('#unified-payload-body').inputValue(),/SYNTHETIC XHS COPY/);
  await page.locator('#unified-platform').selectOption('wechat_channels');assert.equal(await page.locator('#unified-create').isDisabled(),true);assert.match(await page.locator('#unified-create-reason').innerText(),/未配置/);
  await page.locator('#unified-platform').selectOption('facebook');await page.getByLabel('发布账号',{exact:true}).selectOption(demo.accountId);await page.waitForFunction(()=>document.querySelectorAll('#unified-jobs > article').length===2);
  steps.push('two distinct full IDs sharing 074, complete image/text preview, separate platform copy, per-account task queues, missing-platform account blocks creation');
  for(const route of ['verification','groups','inbox','engagement','proactive','settings','customers','access']){
   await page.locator('nav [data-route="'+route+'"]').click();await page.locator('nav [data-route="'+route+'"].active').waitFor();assert.ok((await page.locator('main').innerText()).length>20);await width();
  }
  steps.push('original Tabs render without browser errors; navigation is not proof of live business completion');
  await page.locator('nav [data-route="production-review"]').click();const review=page.locator('[data-production-review="'+demo.archive_receipt.id+'"]');await review.locator('summary').first().click();await review.locator('[data-production-approval]').waitFor();
  assert.match(await review.innerText(),/REVIEW_REQUIRED/);assert.match(await review.innerText(),/FULL_DECODE|DECODED/);await page.waitForFunction(()=>document.querySelector('#production-reviews video')?.readyState>=2);const video=review.locator('video');assert.equal(await video.evaluate(v=>v.videoWidth),320);await video.evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('#production-reviews video')?.ended);await video.scrollIntoViewIfNeeded();await width();await capture('archive-video');
  for(const check of await review.locator('[data-production-check]').all())await check.check();await review.locator('[data-content-only]').check();await review.locator('[data-approval-reason]').fill('Synthetic final integrated acceptance');await review.locator('[data-production-decide="APPROVE"]').click();await review.locator('[data-approval-state="CONTENT_APPROVED"]').waitFor();await review.locator('[data-production-approval]').scrollIntoViewIfNeeded();await width();await capture('approval');
  const metrics=page.locator('#metric-observations');await page.waitForFunction(()=>document.querySelectorAll('[data-metric-series]').length===2);assert.match(await metrics.innerText(),/views：不可用/);assert.match(await metrics.innerText(),/reach：40/);const views=metrics.locator('[data-metric-series]').filter({has:page.locator('summary').filter({hasText:'views：'})});await views.locator('summary').click();await views.locator('a[download]').first().waitFor();assert.match(await views.innerText(),/SYNTHETIC_PERMISSION_DENIED/);await metrics.scrollIntoViewIfNeeded();await width();await capture('metrics');
  await page.reload();await page.locator('[data-route="production-review"]').click();await page.locator('[data-production-review="'+demo.archive_receipt.id+'"] > summary').click();await page.locator('[data-approval-state="CONTENT_APPROVED"]').waitFor();
  steps.push('ZIP multipart resolve + hash/image/full video decode, browser playback, explicit admin decision + durable readback, current unavailable views and separate reach');
  await page.locator('#operating-account').selectOption(demo.secondAccountId);await page.waitForFunction(()=>document.querySelector('#production-reviews')?.textContent.includes('暂无')&&document.querySelector('#metric-observations')?.textContent.includes('暂无'));assert.equal(await page.locator('[data-production-review],[data-metric-series]').count(),0);
  await page.locator('#ws').selectOption(demo.otherWorkspace);await page.waitForFunction(()=>document.querySelector('#production-reviews')?.textContent.includes('暂无'));await page.locator('[data-route="v1"]').click();assert.equal(await page.locator('#unified-content option').count(),0);assert.equal(await page.locator('#unified-jobs > article').count(),0);await width();
  const db=new DatabaseSync(demo.dbPath);try{assert.deepEqual(db.prepare('SELECT DISTINCT state FROM publisher_jobs').all().map(x=>x.state),['DRAFT']);assert.equal(db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,3);assert.equal(db.prepare('SELECT count(*) n FROM production_approval_events').get().n,1);}finally{db.close();}
  assert.equal(adapterCalls,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.ok(writes.every(p=>p==='/auth/login'||p.endsWith('/accounts/select')||p.endsWith('/decision')));
  steps.push('customer/account isolation, three original DRAFT jobs unchanged, zero adapter calls or external browser requests');
  if(evidence)writeFileSync(join(evidence,name+'-journey.json'),JSON.stringify({viewport,steps,external,errors,writes,adapterCalls,realPlatformVerified:false,syntheticOnly:true},null,2));
 }finally{await browser?.close();await new Promise(r=>app.close(r));rmSync(root,{recursive:true,force:true});}
});
