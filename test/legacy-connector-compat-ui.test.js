import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {legacyFixture} from './helpers/legacy-connections-fixture.js';
import {previewLegacyConnections,registerLegacyConnections} from '../src/legacy-connections.js';
import {createApp} from '../src/server.js';

// Explicit isolated real UI check. Excluded from mock-only full-suite runner.
test('existing publisher UI selects original-style MCP/video mappings, previews image/video and isolates customers', {timeout:90000},async t=>{
 const f=legacyFixture(),folder=process.env.COMPAT_UI_EVIDENCE||f.root;
 mkdirSync(folder,{recursive:true});let browser,server,driverCalls=0;const errors=[],external=[],writes=[],steps=[];
 t.after(async()=>{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));f.cleanup();});
 try{
  const p=previewLegacyConnections(f.store.db,f.options);registerLegacyConnections(f.publisher,{...f.options,confirm_workspace:f.ws.id,preview_hash:p.preview_hash});
  const accounts=f.publisher.accountsView(f.ws.id).publisherAccounts,xhs=accounts.find(a=>a.platform==='xiaohongshu'),channel=accounts.find(a=>a.platform==='wechat_channels'),profile=f.publisher.context(f.ws.id,channel.id).profile;
  assert.equal(profile.user_data_dir,f.channelDir);assert.equal(profile.cdp_port,19224);
  const frozen=join(f.root,'frozen'),image=join(frozen,'cover.png'),video=join(frozen,'movie.mp4');mkdirSync(frozen);copyFileSync(f.image,image);
  execFileSync('/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x240:d=1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',video]);
  const content=f.content({media:[image],platform_payloads:{xiaohongshu:{title:'Fixture XHS',body:'Complete XHS fixture body.\nSecond XHS paragraph.',tags:['Fixture'],media:[image]},wechat_channels:{title:'Fixture Channel',body:'Complete video fixture body.\nSecond video paragraph.',tags:['Fixture'],media:[video]}}});
  const cloud={mode:'mac-tunnel',executionConnected:true,host:'publisher.vietbridge.one',origin:'https://publisher.vietbridge.one',user:'fixture',password:'disposable-compat-password',dataDir:f.root,accessFile:join(f.root,'access.json')};
  server=createApp(f.dbPath,{unified:true,cloud,executionEnabled:false,scanScheduler:false,contentSync:{automatic:false,sources:[]},library:{roots:[f.contentRoot],snapshotRoot:frozen,gptInboxBase:null},drivers:{create:async()=>{driverCalls++;throw Error('No real connector or platform operations allowed');}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill(cloud.user);await page.getByLabel('密码',{exact:true}).fill(cloud.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('#ws').selectOption(f.ws.id);
  const platform=()=>page.getByLabel('发布平台（与账号配置分开）'),account=()=>page.getByLabel('发布账号',{exact:true});
  await platform().selectOption('xiaohongshu');await account().selectOption(xhs.id);await page.waitForFunction(id=>document.querySelector('#operating-account')?.value===id,xhs.id);await page.getByLabel('选择共享内容').selectOption(content.id);
  await page.getByText('当前账号的连接与发布方式',{exact:true}).click();assert.match(await page.locator('#unified-target-identity').innerText(),/Fixture XHS/);assert.match(await page.locator('#unified-publisher').innerText(),/MCP.*18060\/mcp.*无需Chrome环境/);
  await page.getByRole('button',{name:'预览完整图文',exact:true}).click();let dialog=page.getByRole('dialog');assert.match(await dialog.innerText(),/Second XHS paragraph/);await dialog.locator('img').evaluate(img=>img.decode());assert.equal(await dialog.locator('img').evaluate(img=>img.naturalWidth>0),true);await page.screenshot({path:join(folder,'XHS-PREVIEW.png')});await page.keyboard.press('Escape');steps.push('MCP target and complete decoded image preview');
  await platform().selectOption('wechat_channels');assert.equal(await page.getByLabel('选择共享内容').inputValue(),content.id);await account().selectOption(channel.id);await page.waitForFunction(id=>document.querySelector('#operating-account')?.value===id,channel.id);
  await page.getByText('当前账号的连接与发布方式',{exact:true}).click();assert.match(await page.locator('#unified-target-identity').innerText(),/Fixture Channel/);assert.match(await page.locator('#unified-publisher').innerText(),/视频号.*BROWSER/);
  await page.getByRole('button',{name:'预览完整图文',exact:true}).click();dialog=page.getByRole('dialog');assert.match(await dialog.innerText(),/Second video paragraph/);
  await dialog.locator('video').evaluate(video=>Promise.race([video.play(),new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture video playback timed out')),10000))]));assert.equal(await dialog.locator('video').evaluate(video=>video.videoWidth>0&&video.duration>0&&!video.error),true);await page.screenshot({path:join(folder,'CHANNELS-PREVIEW.png')});await page.keyboard.press('Escape');steps.push('Original directory/19224 metadata and playable complete video preview');
  for(const value of ['facebook','wechat_official_account']){await platform().selectOption(value);assert.equal(await account().isDisabled(),true);assert.equal(await page.locator('#unified-create').isDisabled(),true);assert.match(await page.locator('#unified-platform-status').innerText(),/尚无此平台发布账号/);assert.equal(await page.getByLabel('选择共享内容').inputValue(),content.id);}steps.push('Missing FB/OA configuration stays blocked without losing selected content');
  await page.locator('#ws').selectOption(f.lp.id);await page.waitForFunction(id=>document.querySelector('#app')?.dataset.workspace===id,f.lp.id);assert.equal(await page.locator('#unified-publisher').count(),0);assert.doesNotMatch(await page.locator('main').innerText(),/Fixture XHS|Fixture Channel/);
  await page.locator('#ws').selectOption(f.ws.id);await page.waitForFunction(id=>document.querySelector('#app')?.dataset.workspace===id,f.ws.id);await platform().selectOption('xiaohongshu');await account().selectOption(xhs.id);await page.waitForFunction(id=>document.querySelector('#operating-account')?.value===id,xhs.id);steps.push('LP/VietBridge switch never mixes target accounts');
  await page.getByRole('button',{name:'账号与授权',exact:true}).click();assert.equal(await page.locator('[data-launch]').count(),0);assert.notEqual(await page.locator('#profile-dir').inputValue(),f.channelDir);
  await page.getByText('配置当前客户的平台账号（使用现有授权）',{exact:true}).click();const form=page.locator('#unified-account-form');assert.equal(await form.locator('[name=profile_id]').isDisabled(),true);await form.locator('[name=id]').selectOption(channel.id);assert.equal(await form.locator('[name=profile_id]').isDisabled(),false);await form.locator('[name=id]').selectOption('');assert.equal(await form.locator('[name=profile_id]').isDisabled(),true);await page.screenshot({path:join(folder,'ACCOUNT-CONFIG.png')});steps.push('XHS profile input disabled; channel environment excluded from FB launch controls');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(driverCalls,0);assert.ok(writes.every(path=>path==='/auth/login'||path.endsWith('/accounts/select')));assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
  writeFileSync(join(folder,'UI-EVIDENCE.json'),JSON.stringify({kind:'ISOLATED_NORMAL_PUBLISHER_UI',steps,errors,external_requests:external,driver_calls:driverCalls,posts:writes,created_jobs:0,flags:{execution:false,scan:false,automatic_sync:false},fixture_only:true,live_identity_verified:false,production_changed:false,original_browser_accessed:false},null,2));
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));f.cleanup();}
});
