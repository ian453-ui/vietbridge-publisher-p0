import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiDriver,BrowserDriver} from '../src/unified-drivers.js';
const snapshot={workspace:'w',accountId:'a',externalId:'61594159443807',operatorActorId:'61594159443807',targetPageId:'1459220443931651',expectedIdentity:'Page',body:'approved complete body',title:'Title',contentHash:'hash',media:[],cdpPort:19999};
test('API adapter validates target, dry-runs, submits once and independently verifies full body and author',async t=>{
  const root=mkdtempSync(join(tmpdir(),'vb-api-driver-')),config=join(root,'fixture.env');writeFileSync(config,'FB_PAGE_ID=1459220443931651\n',{mode:0o600});t.after(()=>rmSync(root,{recursive:true,force:true}));
  const calls=[],client={async useConfig(path){assert.equal(path,config);},async call(name,args){calls.push([name,args]);if(name==='fb_get_auth_status')return {status:'ready',page_id:'1459220443931651'};if(name==='fb_get_page_feed')return {posts:[]};if(name==='fb_get_post_details')return {id:'12345_999',from:{id:'1459220443931651'},message:snapshot.body};return args.dry_run?{dry_run:true}:{post_id:'12345_999'};},async close(){}};
  const s={...snapshot,credentialRef:config},driver=new ApiDriver(s,{client});await driver.prepare(s,[]);const receipt=await driver.submit();const result=await driver.readback(s,receipt);
  assert.equal(result.verified,true);assert.equal(result.targetPageId,snapshot.targetPageId);assert.equal(result.operatorActorId,snapshot.operatorActorId);assert.equal(calls.filter(([name,args])=>name==='fb_publish_post'&&args.dry_run===false).length,1);
  client.call=async()=>({status:'ready',page_id:'wrong'});await assert.rejects(()=>driver.prepare(s,[]),/身份/);
});
test('browser adapter verifies actor before fill and submit, and never calls an API fallback',async()=>{
  const calls=[],facebook={async inspect(){calls.push('identity');return {healthy:true,externalId:'61594159443807'};}},browser={browser:{},async connect(){calls.push('connect');},async publishedMatch(){return null;},async fill(body){assert.equal(body,snapshot.body);calls.push('fill');},async readiness(){calls.push('readiness');return {actionabilityTrialPassed:true};},async submit(){calls.push('submit');},async readback(){calls.push('readback');return {id:'999',url:'https://www.facebook.com/12345/posts/999'};},async close(){}};
  const driver=new BrowserDriver(snapshot,facebook,{browser});await driver.prepare(snapshot,[]);await driver.submit();assert.equal((await driver.readback(snapshot)).verified,true);
  assert.ok(calls.indexOf('identity')<calls.indexOf('fill'));assert.equal(calls.filter(x=>x==='submit').length,1);
  facebook.inspect=async()=>({healthy:true,externalId:'wrong'});await assert.rejects(()=>driver.submit(),/身份/);
  await assert.rejects(()=>driver.prepare(snapshot,['video.mp4']),/身份/);
  facebook.inspect=async()=>({healthy:true,externalId:'61594159443807'});
  browser.fill=async(body,assets,options)=>{assert.equal(options.video,true);assert.deepEqual(assets,['video.mp4']);};
  await driver.prepare(snapshot,['video.mp4']);
});
test('distinct LP actor and Business Page are routed independently; old single-ID snapshots fail closed',async()=>{
  const facebook={async inspect(){return {healthy:true,externalId:snapshot.operatorActorId};}};
  const driver=new BrowserDriver(snapshot,facebook);
  assert.equal(driver.browser.account.page_id,'1459220443931651');
  assert.equal(driver.browser.browserPageId,'61594159443807');
  assert.match(driver.browser.composerUrl(),/asset_id=1459220443931651/);
  assert.match(driver.browser.listUrl(),/asset_id=1459220443931651/);
  await driver.identity();
  facebook.inspect=async()=>({healthy:true,externalId:snapshot.targetPageId});
  await assert.rejects(()=>driver.identity(),/身份/);
  assert.throws(()=>new BrowserDriver({...snapshot,operatorActorId:undefined},facebook),/独立冻结/);
  assert.throws(()=>new ApiDriver({...snapshot,targetPageId:undefined},{client:{}}),/独立冻结/);
});
