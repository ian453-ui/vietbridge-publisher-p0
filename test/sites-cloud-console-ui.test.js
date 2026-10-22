import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {createCloudAuthoringApi} from '../src/sites/cloud-authoring-api.js';

async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'v3-sites-console-')),db=cloudD1Fixture(join(root,'cloud.sqlite'));let api,origin;
 const files={'/':['cloud-console.html','text/html; charset=utf-8'],'/cloud-console.js':['cloud-console.js','text/javascript'],'/cloud-console.css':['cloud-console.css','text/css']};
 const server=createServer(async(req,res)=>{try{
  if(req.headers.host!==new URL(origin).host){res.writeHead(409);return res.end();}
  const file=files[req.url];if(file){res.writeHead(200,{'Content-Type':file[1],'Content-Security-Policy':"default-src 'self'; object-src 'none'; frame-ancestors 'none'"});return res.end(readFileSync(new URL('../src/sites/'+file[0],import.meta.url)));}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),response=await api(new Request(origin+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 // Test-only fixed identity. No request header, body or cookie can choose it.
 api=createCloudAuthoringApi({db:db.db,origin,getTrustedIdentity:async()=>({userId:'synthetic-owner'})});
 t.after(async()=>{await new Promise(r=>server.close(r));db.close();rmSync(root,{recursive:true,force:true});});return {root,db,origin};
}
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test(name+' cloud console persists customer/account/content/platform/task with full preview and reload',{timeout:40000},async t=>{
 const f=await setup(t);let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext({viewport}),outside=[],errors=[];await context.route('**/*',r=>new URL(r.request().url()).origin===f.origin?r.continue():(outside.push(r.request().url()),r.abort()));const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.goto(f.origin);await page.locator('#empty:not([hidden])').waitFor();
  await page.locator('[data-open-settings]').click();await page.locator('#workspace-form [name=name]').fill('合成云端客户');await page.locator('#workspace-form button').click();await page.locator('#workspace option').filter({hasText:'合成云端客户'}).waitFor({state:'attached'});
  await page.locator('#account-form [name=display_name]').fill('合成 Facebook 账号');await page.locator('#account-form button').click();await page.locator('#account option').filter({hasText:'合成 Facebook 账号'}).waitFor({state:'attached'});await page.locator('[data-tab=content]').click();await page.locator('#new-content').click();
  await page.locator('#content-form [name=content_id]').fill('STUDY-20261022-074');await page.locator('#content-form [name=slug]').fill('study-options');await page.locator('#content-form [name=title]').fill('合成完整正文 · 074');await page.locator('#content-form [name=body]').fill('第一段完整正文。\n第二段保留，不截断。');await page.locator('#content-form [name=platform_body]').fill('明确 Facebook 平台稿。\n平台完整结尾。');await page.locator('#content-form button[type=submit]').click();await page.locator('[data-content]').waitFor();
  await page.locator('[data-preview]').click();await page.getByRole('dialog').waitFor();assert.match(await page.locator('#preview-body').innerText(),/平台完整结尾/);await page.locator('#preview-body summary').click();assert.match(await page.locator('#preview-body').innerText(),/第二段保留，不截断/);await page.locator('#close-preview').click();await page.locator('[data-freeze]').dblclick();await page.locator('[data-task]').waitFor();assert.match(await page.locator('#tasks').innerText(),/DRAFT/);assert.equal(f.db.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);
  await page.reload();await page.locator('[data-content]').waitFor();await page.locator('[data-tab=tasks]').click();await page.locator('[data-task]').waitFor();await page.locator('[data-task-preview]').click();assert.match(await page.locator('#preview-body').innerText(),/平台完整结尾/);await page.locator('#close-preview').click();
  assert.equal(await page.locator('nav [data-tab]').count(),9);for(const tab of ['review','verification','groups','inbox','engagement','metrics']){await page.locator('[data-tab='+tab+']').click();assert.match(await page.locator('[data-panel='+tab+']').innerText(),/尚未|未接入|待接入|没有|不具备|未启用/);}
  await page.locator('[data-tab=tasks]').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));if(process.env.V3_SITES_EVIDENCE_DIR){mkdirSync(process.env.V3_SITES_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.V3_SITES_EVIDENCE_DIR,name+'-cloud-tasks.png'),fullPage:true});}
  assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);assert.equal(f.db.sql.prepare("SELECT count(*) n FROM publisher_jobs WHERE state<>'DRAFT'").get().n,0);
 }finally{await browser?.close();}
});

test('delayed old account and old customer responses cannot replace current cloud console data',{timeout:30000},async t=>{
 const f=await setup(t),post=async(path,body)=>(await(await fetch(f.origin+path,{method:'POST',headers:{origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify({command_id:crypto.randomUUID(),...body})})).json());
 const w=(await post('/api/sites/workspaces',{name:'First synthetic customer'})).id,w2=(await post('/api/sites/workspaces',{name:'Second synthetic customer'})).id,base='/api/sites/workspaces/'+w,account=async(ws,name)=>(await post('/api/sites/workspaces/'+ws+'/accounts',{display_name:name,platform:'facebook',external_identity:null})).id,a=await account(w,'Account A'),b=await account(w,'Account B'),c=await account(w2,'Account C');
 for(const [ws,id,title] of [[w,a,'Only A body'],[w,b,'Only B body'],[w2,c,'Only C body']])await post('/api/sites/workspaces/'+ws+'/contents',{account_id:id,content_id:'TEST-20261022-074',slug:'scope-test',revision:1,title,body:title,variants:{facebook:{title,body:title}}});
 let browser;try{
  browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});const context=await browser.newContext(),outside=[];await context.route('**/*',r=>new URL(r.request().url()).origin===f.origin?r.continue():(outside.push(r.request().url()),r.abort()));const page=await context.newPage();page.setDefaultTimeout(8000);await page.goto(f.origin);await page.locator('#account option[value="'+a+'"]').waitFor({state:'attached'});await page.locator('#contents').getByText('Only A body',{exact:true}).waitFor();
  let release,started;const held=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});await page.route('**/contents?accountId='+a,async route=>{started();await gate;await route.continue();});await page.locator('#refresh').click();await held;await page.locator('#account').selectOption(b);await page.locator('#contents').getByText('Only B body',{exact:true}).waitFor();release();await page.waitForTimeout(100);assert.doesNotMatch(await page.locator('#contents').innerText(),/Only A body/);
  await page.unroute('**/contents?accountId='+a);let releaseOld,startedOld;const oldHeld=new Promise(r=>{startedOld=r;}),oldGate=new Promise(r=>{releaseOld=r;});await page.route('**/contents?accountId='+b,async route=>{startedOld();await oldGate;await route.continue();});await page.locator('#refresh').click();await oldHeld;await page.locator('#workspace').selectOption(w2);await page.locator('#contents').getByText('Only C body',{exact:true}).waitFor();releaseOld();await page.waitForTimeout(100);assert.doesNotMatch(await page.locator('#contents').innerText(),/Only A body|Only B body/);
  assert.deepEqual(outside,[]);
 }finally{await browser?.close();}
});
