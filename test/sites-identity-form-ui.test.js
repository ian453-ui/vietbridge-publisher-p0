import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {createCloudAuthoringApi} from '../src/sites/cloud-authoring-api.js';

async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'sites-identity-ui-')),db=cloudD1Fixture(join(root,'db.sqlite'));let origin,api;
 const files={'/':['cloud-console.html','text/html'],'/cloud-console.js':['cloud-console.js','text/javascript'],'/cloud-console.css':['cloud-console.css','text/css']};
 const server=createServer(async(req,res)=>{try{const file=files[req.url];if(file){res.writeHead(200,{'Content-Type':file[1],'Content-Security-Policy':"default-src 'self'; object-src 'none'"});return res.end(readFileSync(new URL('../src/sites/'+file[0],import.meta.url)));}const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),response=await api(new Request(origin+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;api=createCloudAuthoringApi({db:db.db,origin,getTrustedIdentity:async()=>({userId:'synthetic-owner'})});
 const browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/usr/bin/chromium',headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();rmSync(root,{recursive:true,force:true});});
 async function account(workspace,name){return (await db.call('/api/sites/workspaces/'+workspace+'/accounts',{command_id:crypto.randomUUID(),display_name:name,platform:'xiaohongshu',external_identity:null})).body.id;}
 async function workspace(name){return (await db.call('/api/sites/workspaces',{command_id:crypto.randomUUID(),name})).body.id;}
 return {db,origin,browser,account,workspace};
}
async function waitForRow(f,account,identity){for(let i=0;i<50;i++){if(f.db.sql.prepare('SELECT external_identity FROM sites_account_details WHERE account_id=?').get(account)?.external_identity===identity)return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('identity write did not arrive');}

test('identity draft stays with its account and customer when selection changes',{timeout:40000},async t=>{
 const f=await setup(t),w1=await f.workspace('Enterprise'),a=await f.account(w1,'A'),b=await f.account(w1,'B'),w2=await f.workspace('Study'),c=await f.account(w2,'C'),page=await f.browser.newPage();await page.goto(f.origin);await page.locator('[data-tab=settings]').click();
 await page.locator('#identity-form').waitFor({state:'visible'});assert.equal(await page.locator('#account').inputValue(),a);
 await page.locator('#identity-form [name=external_identity]').fill('redid:A-only');await page.locator('#identity-form [name=evidence_note]').fill('Synthetic A evidence');
 await page.locator('#account').selectOption(b);await page.locator('#identity-form').waitFor({state:'visible'});assert.equal(await page.locator('#identity-form [name=external_identity]').inputValue(),'');
 await page.locator('#identity-form [name=external_identity]').fill('redid:B-only');await page.locator('#identity-form [name=evidence_note]').fill('Synthetic B evidence');
 await page.locator('#workspace').selectOption(w2);await page.locator('#identity-form').waitFor({state:'visible'});assert.equal(await page.locator('#account').inputValue(),c);assert.equal(await page.locator('#identity-form [name=external_identity]').inputValue(),'');
 await page.locator('#workspace').selectOption(w1);await page.locator('#account').selectOption(b);assert.equal(await page.locator('#identity-form [name=external_identity]').inputValue(),'redid:B-only');
 await page.locator('#identity-form button[type=submit]').click();await waitForRow(f,b,'redid:B-only');
 assert.equal(f.db.sql.prepare('SELECT external_identity FROM sites_account_details WHERE account_id=?').get(a).external_identity,null);assert.equal(f.db.sql.prepare('SELECT external_identity FROM sites_account_details WHERE account_id=?').get(c).external_identity,null);
 await page.locator('#account').selectOption(a);assert.equal(await page.locator('#identity-form [name=external_identity]').inputValue(),'redid:A-only');
});

test('in-flight identity write stays on captured account without clearing another draft',{timeout:40000},async t=>{
 const f=await setup(t),w=await f.workspace('Enterprise'),a=await f.account(w,'A'),b=await f.account(w,'B'),page=await f.browser.newPage();let entered,release;const enteredPromise=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 await page.route(/\/accounts\/[^/]+\/identity$/,async route=>{entered();await gate;await route.continue();});await page.goto(f.origin);await page.locator('[data-tab=settings]').click();
 await page.locator('#identity-form').waitFor({state:'visible'});await page.locator('#identity-form [name=external_identity]').fill('redid:A');await page.locator('#identity-form [name=evidence_note]').fill('Synthetic A evidence');await page.locator('#identity-form button[type=submit]').click();await enteredPromise;
 await page.locator('#account').selectOption(b);await page.locator('#identity-form [name=external_identity]').fill('redid:B-draft');release();await waitForRow(f,a,'redid:A');
 assert.equal(await page.locator('#identity-form [name=external_identity]').inputValue(),'redid:B-draft');assert.equal(f.db.sql.prepare('SELECT external_identity FROM sites_account_details WHERE account_id=?').get(b).external_identity,null);
});

test('validation failure permits corrected retry; success persists after reload',{timeout:40000},async t=>{
 const f=await setup(t),w=await f.workspace('Enterprise'),a=await f.account(w,'A'),page=await f.browser.newPage();let calls=0;await page.route(/\/accounts\/[^/]+\/identity$/,route=>{if(++calls===1)return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'INVALID_ACCOUNT_IDENTITY'})});return route.continue();});await page.goto(f.origin);await page.locator('[data-tab=settings]').click();
 await page.locator('#identity-form').waitFor({state:'visible'});await page.locator('#identity-form [name=external_identity]').fill('redid:old');await page.locator('#identity-form [name=evidence_note]').fill('Synthetic evidence');await page.locator('#identity-form button[type=submit]').click();await page.getByText('请修正后重试',{exact:false}).waitFor();
 await page.locator('#identity-form [name=external_identity]').fill('redid:corrected');await page.locator('#identity-form button[type=submit]').click();await waitForRow(f,a,'redid:corrected');assert.equal(calls,2);
 await page.reload();await page.locator('#identity-form').waitFor({state:'hidden'});assert.equal(f.db.sql.prepare('SELECT authorization_state FROM sites_account_details WHERE account_id=?').get(a).authorization_state,'UNCONFIGURED');
});

test('unknown response requires scope readback before reusing the same command',{timeout:40000},async t=>{
 const f=await setup(t),w=await f.workspace('Enterprise'),a=await f.account(w,'A'),page=await f.browser.newPage();let calls=0,first;
 await page.route(/\/accounts\/[^/]+\/identity$/,route=>{const body=route.request().postDataJSON();if(++calls===1){first=body;return route.abort('failed');}assert.equal(body.command_id,first.command_id);assert.equal(body.external_identity,first.external_identity);return route.continue();});await page.goto(f.origin);await page.locator('[data-tab=settings]').click();
 await page.locator('#identity-form').waitFor({state:'visible'});await page.locator('#identity-form [name=external_identity]').fill('redid:A');await page.locator('#identity-form [name=evidence_note]').fill('Synthetic evidence');await page.locator('#identity-form button[type=submit]').click();await page.getByText('请先刷新核对原账号',{exact:false}).waitFor();assert.equal(await page.locator('#identity-form button[type=submit]').isDisabled(),true);
 await page.locator('#refresh').click();await page.locator('#identity-form button[type=submit]:not([disabled])').waitFor();assert.equal(await page.locator('#identity-form [name=external_identity]').inputValue(),'redid:A');await page.locator('#identity-form button[type=submit]').click();await waitForRow(f,a,'redid:A');assert.equal(calls,2);
});
