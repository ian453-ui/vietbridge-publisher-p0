import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../src/server.js';
import {v3ReviewDemo} from '../scripts/v3-review-demo.mjs';

test('original Tabs show persisted production text/media, play synthetic video and isolate customer switches', {timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'v3-review-browser-')),demo=v3ReviewDemo(join(root,'demo'));
 const server=createApp(demo.dbPath,{unified:true,executionEnabled:false,scanScheduler:false});
 let browser;
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});
  const context=await browser.newContext(),outside=[],errors=[],posts=[];
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(outside.push(r.request().url()),r.abort()));
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
  await page.goto(origin);await page.locator('#ws').selectOption(demo.workspace);await page.locator('[data-route="production-review"]').waitFor();
  for(const tab of ['v1','verification','groups','inbox','engagement','proactive','settings'])assert.equal(await page.locator('[data-route="'+tab+'"]').count(),1);
  await page.locator('[data-route="production-review"]').click();await page.locator('[data-production-review] summary').click();
  await page.waitForFunction(()=>document.querySelector('#production-reviews pre')?.textContent.includes('Synthetic'));
  assert.match(await page.locator('#production-reviews').innerText(),/REVIEW_REQUIRED/);
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  assert.equal(await page.locator('video').evaluate(v=>v.videoWidth),320);
  await page.locator('video').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('video')?.ended);
  if(process.env.V3_REVIEW_SCREENSHOT)await page.screenshot({path:process.env.V3_REVIEW_SCREENSHOT,fullPage:true});
  await page.locator('#ws').selectOption(demo.otherWorkspace);await page.waitForFunction(()=>document.getElementById('production-reviews')?.textContent.includes('暂无'));
  assert.equal(await page.locator('video').count(),0);assert.equal(await page.locator('[data-production-review]').count(),0);
  assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
 }finally{await browser?.close();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});
