import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
import {XiaohongshuPublishDriver,WechatDraftPublishDriver,WechatChannelsPublishDriver,prepareDraft} from '../src/multiplatform-drivers.js';
import {unifiedPublisherView,unifiedAccountManagerView} from '../src/unified-client.js';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'vb-multiplatform-')),store=new Store(join(root,'publisher-unified.sqlite'),{seedDemo:false}),publisher=new UnifiedPublisher(store);
  const ws=store.saveWorkspace({name:'Enterprise',content_root:root}),other=store.saveWorkspace({name:'Other'});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const image=join(root,'cover.png'),video=join(root,'movie.mp4'),config=join(root,'wechat.env');
  writeFileSync(image,Buffer.from([137,80,78,71,13,10,26,10,1]));writeFileSync(video,Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50]));writeFileSync(config,'WECHAT_APP_ID=wx0123456789abcdef\n',{mode:0o600});
  let port=19500;
  const account=(platform,external)=>{const profile=store.saveProfile(ws.id,{name:platform,cdp_port:++port,user_data_dir:join(root,'chrome-'+port)});mkdirSync(profile.user_data_dir);return publisher.saveAccount(ws.id,{platform,external_id:external||({xiaohongshu:'username:Operator',wechat_official_account:'wx0123456789abcdef',wechat_channels:'sph-fixture',facebook:'12345'})[platform],operator_actor_id:platform==='facebook'?'12345':undefined,target_page_id:platform==='facebook'?'98765':undefined,identity_type:'PAGE',display_name:'Operator',expected_identity:'Operator',profile_id:profile.id,config_url:platform==='wechat_official_account'?config:undefined});};
  let number=0;
  const job=(account,media=[image],payload={})=>{const content=publisher.importContent(ws.id,{source_id:'content-'+(++number),revision:'1',title:'Approved title',body:'Approved complete body',media});return publisher.createPageJob(ws.id,{account_id:account.id,content_id:content.id,payload:{tags:['Business'],...payload}});};
  const executor=driver=>new UnifiedExecutor(publisher,{enabled:true,resources:new BrowserResources(join(root,'locks')),drivers:{create:async()=>driver},mediaRoots:[root],snapshotRoot:join(root,'snapshots')});
  return {root,store,publisher,ws,other,image,video,account,job,executor};
}
const proof=(s,extra)=>({verified:true,platform:s.platform,accountId:s.externalId,contentHash:s.contentHash,payloadHash:s.payloadHash,...extra});

test('all platform accounts use one registry, share customer content and stay outside Facebook interaction',t=>{
  const f=fixture(t),accounts=['facebook','xiaohongshu','wechat_official_account','wechat_channels'].map(p=>f.account(p));
  assert.equal(f.publisher.accountsView(f.ws.id).publisherAccounts.length,4);
  assert.equal(f.store.facebookView(f.ws.id).accounts.length,1);
  for(const a of accounts){f.publisher.selectAccount(f.ws.id,a.id);assert.equal(f.publisher.accountsView(f.ws.id).selectedPublisherAccountId,a.id);}
  assert.throws(()=>f.store.addGroup(f.ws.id,{account_id:accounts[1].id,url:'https://www.facebook.com/groups/123'}),/Facebook/);
  assert.throws(()=>f.publisher.context(f.other.id,accounts[1].id),/不属于/);
  assert.throws(()=>f.publisher.switchTransport(f.ws.id,accounts[1].id,'API'),/Facebook/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM facebook_accounts').get().n,4);
});
test('platform task payloads are frozen and invalid media/title do not silently truncate or fall back',t=>{
  const f=fixture(t),xhs=f.account('xiaohongshu'),channels=f.account('wechat_channels'),wechat=f.account('wechat_official_account');
  assert.throws(()=>f.job(xhs,[f.image],{title:'A'.repeat(21)}),/20/);
  assert.throws(()=>f.job(channels,[f.image]),/MP4/);
  assert.throws(()=>f.job(wechat,[f.video]),/伴随文章/);
  const job=f.job(channels,[f.video]);assert.equal(job.snapshot.transport,'BROWSER');assert.deepEqual(job.snapshot.payload.tags,['Business']);
  f.publisher.saveAccount(f.ws.id,{...channels,publisher_options:{collection:'Changed'}});
  assert.throws(()=>f.publisher.approve(f.ws.id,job.id,job.snapshot_hash),/配置已变化/);
});
test('cloud platform variants share source content while selecting independent media and reject revision drift',t=>{
  const f=fixture(t),wechat=f.account('wechat_official_account');
  const input={source_id:'video-package',revision:'1',title:'Video',body:'Main video caption',media:[f.video],platform_payloads:{wechat_official_account:{title:'Companion',body:'Approved companion article',media:[f.image],author:'Writer'}}};
  const content=f.publisher.importContent(f.ws.id,input),job=f.publisher.createPageJob(f.ws.id,{account_id:wechat.id,content_id:content.id});
  assert.equal(job.snapshot.body,'Approved companion article');assert.deepEqual(job.snapshot.media,[f.image]);assert.deepEqual(job.snapshot.sourceMedia,[f.video]);
  f.publisher.assertCurrent(job);
  assert.throws(()=>f.publisher.importContent(f.ws.id,{...input,platform_payloads:{wechat_official_account:{...input.platform_payloads.wechat_official_account,body:'changed'}}}),/新版本/);
});
test('公众号 terminal state is verified draft, never public publication, and uncertain receipts survive restart',async t=>{
  const f=fixture(t),job=f.job(f.account('wechat_official_account'));let submits=0,readback=false;
  const driver={async prepare(){return {operation:'draft'};},async submit(){submits++;return {id:'draft-fixture'};},async readback(s){if(!readback)throw Error('temporary read failure');return proof(s,{id:'draft-fixture',outcome:'DRAFT_WRITTEN',formalPublication:false});},async close(){}};
  const executor=f.executor(driver);executor.approve(f.ws.id,job.id,job.snapshot_hash);await assert.rejects(()=>executor.execute(f.ws.id,job.id));
  assert.equal(f.publisher.job(f.ws.id,job.id).state,'UNKNOWN');assert.equal(f.store.db.prepare('SELECT platform_id FROM publisher_submit_receipts').get().platform_id,'draft-fixture');
  readback=true;assert.equal((await executor.reconcile(f.ws.id,job.id)).state,'DRAFT_WRITTEN');assert.equal(submits,1);
  assert.throws(()=>f.job(f.publisher.account(f.ws.id,job.account_id)),/已提交/);
});
test('video list confirmation preserves ID-pending semantics and rejects a fake public post status',async t=>{
  const f=fixture(t),job=f.job(f.account('wechat_channels'),[f.video]);
  const driver={async prepare(){return {beforeCount:5};},async submit(){return null;},async readback(s){return proof(s,{outcome:'PUBLISHED_ID_PENDING',publicLinkUnavailable:true});},async close(){}};
  const executor=f.executor(driver);executor.approve(f.ws.id,job.id,job.snapshot_hash);assert.equal((await executor.execute(f.ws.id,job.id)).state,'PUBLISHED_ID_PENDING');
  assert.equal(f.publisher.job(f.ws.id,job.id).evidence.publicLinkUnavailable,true);
});
test('preparation side effects interrupted before final intent stay unknown and cannot be mistaken for a post',async t=>{
  const f=fixture(t),job=f.job(f.account('facebook'),[f.video]);let submits=0;
  const driver={async prepare(s,a,onWrite){onWrite();throw Error('upload interrupted');},async submit(){submits++;},async readback(s){return proof(s,{id:'12345',outcome:'PUBLISHED'});},failureEvidence(){return {finalClickAttempted:false};},async close(){}};
  mkdirSync(job.snapshot.profileDir,{recursive:true});const executor=f.executor(driver);executor.approve(f.ws.id,job.id,job.snapshot_hash);await assert.rejects(()=>executor.execute(f.ws.id,job.id));
  assert.equal(f.publisher.job(f.ws.id,job.id).state,'UNKNOWN');assert.equal(submits,0);
  assert.throws(()=>executor.reopen(f.ws.id,job.id),/重新审核/);
  await assert.rejects(()=>executor.reconcile(f.ws.id,job.id),/最终提交意图/);assert.equal(f.publisher.job(f.ws.id,job.id).state,'UNKNOWN');
  await assert.rejects(()=>executor.resolvePreparation(f.ws.id,job.id),/EXACT_ATTEMPT/);
  const resolved=await executor.resolvePreparation(f.ws.id,job.id,{acknowledge_preparation_effects:true,expected_attempt_id:f.publisher.job(f.ws.id,job.id).attempt_id,snapshot_hash:job.snapshot_hash});
  assert.equal(resolved.state,'BLOCKED');assert.equal(resolved.evidence.preparationEffectsMayRemain,true);assert.equal(submits,0);
  assert.throws(()=>executor.reopen(f.ws.id,job.id),/准备副作用/);
});
test('Xiaohongshu image/video adapters verify identity and full own-note details with separate operation arguments',async t=>{
  const f=fixture(t),account=f.account('xiaohongshu');let images=0,videos=0,wrong=false;
  const client={async loginStatus(){return {loggedIn:true,accountId:account.external_id};},async readbackHealth(){return {ok:true};},async findPublished(){return {status:'unavailable'};},async publishImages(input){images++;assert.deepEqual(input.tags,['Business']);assert.ok(input.images);return {text:'note_id: fixtureNote',raw:{}};},async publishVideo(input){videos++;assert.ok(input.video);return {text:'note_id: fixtureNote',raw:{}};},async readText(name){return JSON.stringify(name==='search_feeds'?{feeds:[{id:'fixtureNote',xsecToken:'not-a-secret-fixture',noteCard:{displayTitle:'Approved title',user:{nickname:'Operator'}}}]}:{data:{note:{id:'fixtureNote',title:'Approved title',desc:wrong?'Wrong':'Approved complete body',user:{nickname:'Operator'}}}});},async close(){}};
  for(const media of [[f.image],[f.video]]){const s=f.job(account,media).snapshot,driver=new XiaohongshuPublishDriver(s,{client});await driver.prepare(s,media);const receipt=await driver.submit();assert.equal((await driver.readback(s,receipt)).verified,true);}
  assert.equal(images,1);assert.equal(videos,1);wrong=true;const driver=new XiaohongshuPublishDriver(f.job(account).snapshot,{client});await assert.rejects(()=>driver.readback(driver.snapshot,{id:'fixtureNote'}),/完整正文/);
});
test('Wechat renderer receives only frozen approved assets and verifies draft without calling a publish endpoint',async t=>{
  const f=fixture(t),s=f.job(f.account('wechat_official_account')).snapshot;
  assert.throws(()=>prepareDraft({...s,body:'![secret](/etc/secret.env)'},[f.image]),/未批准/);
  let writes=0;const reader={async identity(){return s.externalId;},async list(){return {item:[]};},async get(){return {news_item:[{title:s.title,author:s.payload.author,thumb_media_id:'fixture-cover',content:'<p>'+s.body+'</p>'}]};}};
  const client={async call(name,input){if(name==='list_themes')return {text:'default',isError:false};writes++;assert.ok(input.content.includes(f.image));return {text:'media ID is fixture-media',isError:false};},async close(){}};
  const driver=new WechatDraftPublishDriver(s,{reader,client});await driver.prepare(s,[f.image]);assert.equal(writes,0);const receipt=await driver.submit();assert.equal((await driver.readback(s,receipt)).outcome,'DRAFT_WRITTEN');assert.equal(writes,1);
  const fresh=new WechatDraftPublishDriver(s,{reader,client});fresh.restore(s,[f.image]);assert.equal((await fresh.readback(s,receipt)).formalPublication,false);assert.equal(writes,1);
});
test('Channels preparation writes are fenced and recovery never clicks submit again',async t=>{
  const f=fixture(t),s=f.job(f.account('wechat_channels'),[f.video]).snapshot;let writes=0,clicks=0;
  const browser={async findExisting(){return false;},async preflight(){return {ok:true,beforeCount:7};},async prepare(input){assert.equal(writes,1);return input;},async assertIdentity(){},async submitOnce(){clicks++;},async readback(input){assert.equal(input.beforeCount,7);assert.equal(input.expectedDescription,'Approved complete body\n\n#Business');return {outcome:'PUBLISHED_ID_PENDING',evidence:['own_list']};},async close(){}};
  const driver=new WechatChannelsPublishDriver(s,{browser}),prepared=await driver.prepare(s,[f.video],()=>writes++);await driver.submit();assert.equal((await driver.readback(s)).outcome,'PUBLISHED_ID_PENDING');
  const fresh=new WechatChannelsPublishDriver(s,{browser});fresh.restore(s,[f.video],prepared);await fresh.readback(s);assert.equal(clicks,1);
});
test('native multi-platform view exposes configuration with no second V1 binding and labels draft-only actions',t=>{
  const f=fixture(t),account=f.account('wechat_official_account'),html=unifiedPublisherView(f.ws.id,account,[],[],[account]);
  assert.match(html,/公众号草稿/);assert.doesNotMatch(html,/unified-account-form/);assert.match(unifiedAccountManagerView(f.ws.id,[],[account]),/unified-account-form/);assert.match(html,/小红书/);assert.match(html,/视频号/);assert.doesNotMatch(html,/publisherAccountId|iframe/);
});
