import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createPublisherSite} from '../src/sites/worker-entry.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {seedSitesRecords} from './fixtures/sites-evidence.js';

for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test(name+' Worker document, assets and persistent API use one scoped application',{timeout:40000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-worker-ui-')),db=cloudD1Fixture(join(root,'db.sqlite'));let server,browser;
 t.after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}db.close();rmSync(root,{recursive:true,force:true});});const seeded=await seedSitesRecords(db);
 await seeded.post('/api/sites/workspaces/'+seeded.workspace+'/contents',{account_id:seeded.accountId,content_id:'SYNTHETIC-20261023-074',slug:'another-date',revision:1,title:'Synthetic extra',body:'Another complete article.',variants:{facebook:{title:'Extra Facebook copy',body:'Another explicit copy.'}}});
 const other=await seeded.post('/api/sites/workspaces/'+seeded.workspace+'/accounts',{display_name:'Synthetic FB second',platform:'facebook',external_identity:null});
 const assetTypes={'/cloud-console.html':'text/html','/cloud-console.js':'text/javascript','/cloud-console.css':'text/css'};let origin,user='synthetic-owner';
 // Synthetic server-only identity, never a production header parser.
 const app=createPublisherSite({allowLoopback:true,getTrustedIdentity:async()=>user?{userId:user}:null}),env={DB:db.db,ASSETS:{fetch:async request=>{const path=new URL(request.url).pathname;assert.ok(Object.hasOwn(assetTypes,path));return new Response(readFileSync(new URL('../src/sites'+path,import.meta.url)),{headers:{'Content-Type':assetTypes[path]}});}}};
 server=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=Buffer.concat(chunks);
  const response=await app.fetch(new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(data.length?{body:data}:{})}),env);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;env.PUBLISHER_CANONICAL_ORIGIN=origin;
 browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext({viewport}),outside=[],errors=[];
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(outside.push(route.request().url()),route.abort()));const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 const response=await page.goto(origin);assert.equal(response.status(),200);assert.match(response.headers()['content-security-policy'],/script-src 'self'/);await page.locator('[data-content]').first().waitFor();assert.equal(await page.locator('nav [data-tab]').count(),9);
 await page.locator('#content-search').fill('SYNTHETIC-20261023-074');assert.equal(await page.locator('[data-content]').count(),1);assert.match(await page.locator('#contents').innerText(),/another-date/);
 await page.locator('#batch-select').click();assert.equal(await page.locator('#batch-count').innerText(),'已选 1 / 20');await page.locator('#content-search').fill('no matching content');assert.equal(await page.locator('[data-content]').count(),0);assert.match(await page.locator('#contents').innerText(),/没有匹配/);assert.equal(await page.locator('#batch-count').innerText(),'已选 0 / 20');assert.equal(await page.locator('#batch-select').isDisabled(),true);
 await page.locator('#content-search').fill('test-body');assert.equal(await page.locator('[data-content]').count(),1);await page.locator('#account').selectOption(other.id);await page.locator('#scope-status').filter({hasText:'Synthetic FB second'}).waitFor();await page.locator('[data-content]').first().waitFor();assert.equal(await page.locator('#content-search').inputValue(),'');await page.locator('#account').selectOption(seeded.accountId);await page.locator('#scope-status').filter({hasText:'当前账号：Synthetic FB · Facebook'}).waitFor();await page.locator('[data-content]').first().waitFor();
 await page.locator('#target-account').selectOption(seeded.accountId);await page.locator('[data-content]').filter({hasText:'Synthetic body'}).locator('[data-pick]').check();await page.locator('#batch-check').click();await page.locator('#batch-results').getByText('已有冻结任务，保留原回执',{exact:true}).waitFor();assert.equal(await page.locator('#batch-freeze').isDisabled(),true);
 await page.locator('[data-tab=tasks]').click();await page.locator('[data-task-preview]').click();assert.match(await page.locator('#preview-body').innerText(),/Explicit platform copy/);await page.locator('#close-preview').click();await page.reload();await page.locator('[data-task]').waitFor({state:'attached'});assert.equal(await page.locator('[data-task]').count(),1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const missing=await context.request.get(origin+'/api/sites/does-not-exist');assert.equal(missing.status(),404);assert.match(missing.headers()['content-type'],/application\/json/);
 user=null;const anonymous=await context.request.get(origin+'/',{headers:{'oai-authenticated-user-id':'synthetic-owner'}});assert.equal(anonymous.status(),401);assert.equal(db.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);assert.equal(db.sql.prepare('SELECT count(*) n FROM sites_execution_claims').get().n,0);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
});
