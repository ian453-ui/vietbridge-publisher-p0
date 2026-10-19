import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {createApp} from '../src/server.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
test('pending source revision invalidation blocks old draft until explicit reimport',async()=>{
 const root=mkdtempSync(join(tmpdir(),'content-ui-')),client=join(root,'clients','qa');mkdirSync(client,{recursive:true});writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[]}));
 const db=join(root,'fixture.sqlite'),store=new Store(db,{seedDemo:false}),publisher=new UnifiedPublisher(store),ws=store.saveWorkspace({name:'QA',content_root:client}),profile=store.saveProfile(ws.id,{name:'Unused',cdp_port:59997,user_data_dir:join(root,'never-connect')});
 const account=publisher.saveAccount(ws.id,{display_name:'QA Actor',expected_identity:'QA Actor',identity_type:'PAGE',external_id:'123456',operator_actor_id:'123456',target_page_id:'654321',profile_id:profile.id});const second=publisher.saveAccount(ws.id,{display_name:'Second QA Actor',expected_identity:'Second QA Actor',identity_type:'PAGE',external_id:'123457',operator_actor_id:'123457',target_page_id:'654322',profile_id:profile.id});publisher.selectAccount(ws.id,account.id);store.selectAccount(ws.id,account.id);store.close();
 const manifest={project_id:'PROJECT-001',workspace:'independent-client',status:'READY',manifest_revision:1,items:[{content_id:'GOOD-001',status:'READY',body_source:'READY/content/GOOD-001.md',content_drive_file_id:'body',primary_image:'READY/assets/GOOD-001.png',primary_image_drive_file_id:'image'}]};let body='First public body',driverCalls=0;
 const cloud={mode:'mac-tunnel',executionConnected:true,host:'publisher.vietbridge.one',origin:'https://publisher.vietbridge.one',user:'fixture',password:'disposable-ui-fixture-password',dataDir:root,accessFile:join(root,'fixture-access.json')};
 const server=createApp(db,{unified:true,cloud,executionEnabled:true,scanScheduler:false,library:{roots:[root],snapshotRoot:join(root,'frozen'),gptInboxBase:null},contentSync:{sources:[{projectId:'PROJECT-001',workspaceId:ws.id,relativeRoot:'clients/qa',manifestDriveFileId:'manifest'}],makeClient:async()=>({downloadRaw:async id=>id==='manifest'?Buffer.from(JSON.stringify(manifest)):id==='image'?png:Buffer.from('---\npublish_caption: '+body+'\n---\n# Good')})},drivers:{create:async()=>{driverCalls++;throw Error('UI test must never create platform driver');}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;const external=[];
 try{
 browser=await chromium.launch({executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext();await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(external.push(r.request().url()),r.abort()));const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('[name=username]').fill(cloud.user);await page.locator('[name=password]').fill(cloud.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('#ws').selectOption(ws.id);
 await page.locator('#sync-client-source:not([disabled])').waitFor();await page.locator('#sync-client-source').click();await page.locator('.library-item [data-library-pick]').first().waitFor();await page.locator('[data-library-pick]').first().check();await page.locator('#import-library').click();await page.waitForFunction(()=>document.querySelector('#unified-payload-body')?.value==='First public body');
 const selected=await page.locator('#unified-content').inputValue();
 await page.locator('[data-library-pick]').first().uncheck();await page.locator('[data-library-pick]').first().check();
 assert.equal(await page.locator('#unified-create').isDisabled(),true);
 body='Changed while pending selection';await page.locator('#sync-client-source').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.library-item pre')].some(x=>x.textContent==='Changed while pending selection'));
 console.log('Pending revision readback:',JSON.stringify({picked:await page.locator('[data-library-pick]').first().isChecked(),createDisabled:await page.locator('#unified-create').isDisabled(),selected:await page.locator('#unified-content').inputValue(),body:await page.locator('#unified-payload-body').inputValue()}));
 assert.equal(await page.locator('#unified-create').isDisabled(),true,'changed pending selection must remain blocked');
 assert.equal(await page.locator('#unified-payload-body').inputValue(),'');
 await page.locator('#unified-target-account').selectOption(second.id);await page.waitForFunction(id=>document.querySelector('#unified-publisher')?.dataset.account===id,second.id);await page.locator('#unified-target-account').selectOption(account.id);await page.waitForFunction(id=>document.querySelector('#unified-publisher')?.dataset.account===id,account.id);assert.equal(await page.locator('#unified-create').isDisabled(),true,'switching accounts must not clear pending scope');
 await page.locator('[data-library-pick]').first().check();await page.locator('#import-library').click();await page.waitForFunction(()=>document.querySelector('#unified-payload-body')?.value==='Changed while pending selection');assert.equal(await page.locator('#unified-create').isDisabled(),false);assert.equal(driverCalls,0);assert.deepEqual(external,[]);
 }finally{await browser?.close();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});
