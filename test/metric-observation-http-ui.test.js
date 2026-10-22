import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {chromium} from 'playwright-core';
import {createApp} from '../src/server.js';
import {PublisherAccess} from '../src/publisher-access.js';
import {v3MetricDemo} from '../scripts/v3-metric-demo.mjs';

test('metric reads require existing authentication and account scope; writes/app-token scope remain denied',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-metric-http-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const demo=v3MetricDemo(join(root,'demo')),cloud={mode:'cloud',executionConnected:false,origin:'https://fixture.invalid',host:'fixture.invalid',user:'synthetic-admin',password:'synthetic-disposable-test-password',dataDir:root},app=createApp(demo.dbPath,{unified:true,cloud});t.after(()=>app.emit('close'));
 const auth={authorization:'Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64')},scope=new URLSearchParams({workspace:demo.workspace,accountId:demo.accountId}),path='/api/metric-observations?'+scope;
 const call=async(path,headers={},method='GET')=>{const req=Readable.from([]);Object.assign(req,{url:path,method,headers:{host:cloud.host,...headers}});let status=200,body;const responseHeaders={},res={setHeader(k,v){responseHeaders[k]=v;},writeHead(s){status=s;},end(b){body=b;}};await app.listeners('request')[0](req,res);return {status,body,headers:responseHeaders};};
 assert.equal((await call(path)).status,401);const read=await call(path,auth);assert.equal(read.status,200);const report=JSON.parse(read.body);assert.equal(report.snapshots.length,2);
 assert.equal((await call('/api/metric-observations?workspace=other&accountId='+demo.accountId,auth)).status,403);
 const series=report.snapshots[0].series_id;const history=await call('/api/metric-observations/series/'+series+'?'+scope,auth);const entry=JSON.parse(history.body).entries[0].id;
 assert.equal((await call('/api/metric-observations/series/'+series+'?workspace='+demo.otherWorkspace+'&accountId='+demo.otherAccountId,auth)).status,404);
 const raw=await call('/api/metric-observations/evidence/'+entry+'?'+scope,auth);assert.equal(raw.status,200);assert.equal(raw.headers['Content-Type'],'application/octet-stream');assert.match(raw.headers['Content-Disposition'],/attachment/);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await call(path,auth,method)).status,405);
 assert.equal(new PublisherAccess(cloud).authorizeApp({type:'app',token:{workspaces:[demo.workspace],scopes:['jobs:read','content:import','jobs:create']}},'GET',new URL(path,cloud.origin)),false);
});

test('existing Review displays separate synthetic metric history/nulls; delayed account/customer responses stay isolated',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'v3-metric-ui-')),demo=v3MetricDemo(join(root,'demo')),app=createApp(demo.dbPath,{unified:true,executionEnabled:false});let browser,release;
 try{
  await new Promise(r=>app.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.address().port;browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext(),outside=[],posts=[],errors=[];
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(outside.push(route.request().url()),route.abort()));const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET')posts.push(r.method()+' '+new URL(r.url()).pathname);});
  await page.goto(origin);await page.locator('#ws').selectOption(demo.workspace);await page.locator('[data-route="production-review"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-metric-series]').length===2);
  const summaries=await page.locator('[data-metric-series] summary').allTextContents();assert.ok(summaries.some(s=>s.includes('views：不可用')&&s.includes('PERMISSION_DENIED')));assert.ok(summaries.some(s=>s.includes('reach：40')));
  const views=page.locator('[data-metric-series]').filter({has:page.locator('summary').filter({hasText:'views：'})});await views.locator('summary').click();await page.waitForFunction(()=>document.querySelector('[data-metric-history] a')!==null);assert.match(await views.innerText(),/合成测试 · 非用户指标/);assert.match(await views.innerText(),/SYNTHETIC_PERMISSION_DENIED/);assert.equal(await views.locator('a[download]').count(),2);
  if(process.env.V3_METRIC_SCREENSHOT)await page.screenshot({path:process.env.V3_METRIC_SCREENSHOT,fullPage:true});
  let ready,hold=false;await page.route('**/api/metric-observations?*',async route=>{if(!hold||new URL(route.request().url()).searchParams.get('accountId')!==demo.accountId)return route.continue();hold=false;const response=await route.fetch();const gate=new Promise(r=>release=r);ready();await gate;await route.fulfill({response});});
  for(const switchTo of ['account','customer']){
   await page.locator('[data-route="verification"]').click();hold=true;const started=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('METRIC_DELAY_NOT_REACHED')),5000);ready=()=>{clearTimeout(timer);resolve();};});await page.locator('[data-route="production-review"]').click();await started;
   if(switchTo==='account')await page.locator('#operating-account').selectOption(demo.secondAccountId);else await page.locator('#ws').selectOption(demo.otherWorkspace);
   await page.waitForFunction(()=>document.getElementById('metric-observations')?.textContent.includes('暂无'));release();await page.waitForTimeout(100);assert.equal(await page.locator('[data-metric-series]').count(),0);
   if(switchTo==='account'){await page.locator('#operating-account').selectOption(demo.accountId);await page.waitForFunction(()=>document.querySelectorAll('[data-metric-series]').length===2);}
  }
  assert.deepEqual(outside,[]);assert.deepEqual(posts,Array(2).fill('POST /api/unified/workspaces/'+demo.workspace+'/accounts/select'));assert.deepEqual(errors,[]);
 }finally{release?.();await browser?.close();await new Promise(r=>app.close(r));rmSync(root,{recursive:true,force:true});}
});
