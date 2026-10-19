import {FacebookBusinessBrowser} from './publisher-core/facebook-business-browser.ts';
import {BrowserSkillPublicationDriver} from './browser-skill-publication.js';
import {FacebookMcpConnector,assertFacebookReady} from './publisher-core/facebook-mcp-connector.ts';
import {FacebookVideo,verifiedFacebookVideo} from './publisher-core/facebook-video.ts';
import {normalizeLocalConfig,parseConfig} from './publisher-core/facebook-accounts.ts';
import {XiaohongshuPublishDriver,WechatDraftPublishDriver,WechatChannelsPublishDriver} from './multiplatform-drivers.js';
import {observeRetainedComposer} from './composer-observation.js';
import {boundedRead} from './publisher-core/facebook-readiness-observation.ts';
import {runFacebookDiagnostic,boundedDiagnosticCleanup} from './facebook-readonly-diagnostics.js';

const clean=x=>String(x||'').replace(/\s+/g,' ').trim();
function assertIdentities(s){if(!/^\d+$/.test(s.operatorActorId||'')||!/^\d+$/.test(s.targetPageId||'')||s.externalId!==s.operatorActorId)throw Error('操作 actor 与目标 Page 必须独立冻结');}
function unwrap(value){return value?.post||value?.data||value;}

export class ApiDriver {
  constructor(snapshot,{client=new FacebookMcpConnector()}={}){assertIdentities(snapshot);this.snapshot=snapshot;this.client=client;}
  async inspect(){const config=parseConfig(normalizeLocalConfig(this.snapshot.credentialRef));if(String(config.FB_PAGE_ID)!==this.snapshot.targetPageId)throw Error('API 授权与身份不一致');await this.client.useConfig(this.snapshot.credentialRef);const auth=await this.client.call('fb_get_auth_status');assertFacebookReady(auth);if(String(auth.page_id)!==this.snapshot.targetPageId)throw Error('API 实际身份不一致');return {healthy:true,externalId:this.snapshot.operatorActorId,operatorActorId:this.snapshot.operatorActorId,targetPageId:this.snapshot.targetPageId,identityEvidence:'API_TARGET_PAGE_AUTH'};}
  async prepare(snapshot,assets) {
    const config=parseConfig(normalizeLocalConfig(snapshot.credentialRef));
    if(String(config.FB_PAGE_ID)!==snapshot.targetPageId)throw Error('API 授权与任务 Page ID 不一致');
    await this.client.useConfig(snapshot.credentialRef);
    const auth=await this.client.call('fb_get_auth_status');assertFacebookReady(auth);
    if(String(auth.page_id)!==snapshot.targetPageId)throw Error('API 当前身份与任务不一致');
    const videos=assets.filter(x=>x.endsWith('.mp4'));if(videos.length>1||videos.length&&assets.length!==1)throw Error('视频不能与图片混合提交');
    if(videos.length){
      this.video=new FacebookVideo(undefined,snapshot.credentialRef,snapshot.expectedIdentity);await this.video.connect(snapshot.targetPageId);
      const list=await this.video.list();if(!Array.isArray(list.data)||list.paging?.next)throw Error('视频历史核对不完整');
      if(list.data.some(v=>clean(v.description)===clean(snapshot.body)))throw Error('平台已存在相同内容，未重复提交');
      this.assets=assets;return {operation:'FACEBOOK_API_VIDEO',pageId:snapshot.targetPageId};
    }
    const feed=await this.client.call('fb_get_page_feed',{limit:25,since_hours:720});
    const posts=feed.posts||feed.data;if(!Array.isArray(posts))throw Error('Page 历史无法读取，未提交');
    if(posts.some(p=>clean(p.message)===clean(snapshot.body)))throw Error('平台已存在相同内容，未重复提交');
    this.tool=assets.length>1?'fb_publish_photos':assets.length?'fb_publish_photo':'fb_publish_post';
    this.args=assets.length>1?{image_urls:assets,message:snapshot.body}:assets.length?{image_url:assets[0],caption:snapshot.body,alt_text:snapshot.title}:{message:snapshot.body};
    const dry=await this.client.call(this.tool,{...this.args,dry_run:true});if(!/dry_run/i.test(JSON.stringify(dry)))throw Error('API 发布预检未确认');
    return {operation:this.tool,pageId:snapshot.targetPageId};
  }
  async submit() {
    await this.inspect();
    const result=this.video?await this.video.upload(this.assets[0],this.snapshot.title,this.snapshot.body):await this.client.call(this.tool,{...this.args,dry_run:false});
    const id=String(result.post_id||result.id||'');if(!/^\d+(?:_\d+)?$/.test(id))throw Error('API 提交后没有可核对的作品 ID');
    return {id,url:`https://www.facebook.com/${id.replace('_','/posts/')}`};
  }
  async readback(snapshot,receipt) {
    await this.client.useConfig(snapshot.credentialRef);
    const config=parseConfig(normalizeLocalConfig(snapshot.credentialRef));if(String(config.FB_PAGE_ID)!==snapshot.targetPageId)throw Error('核对配置与原 Page 不一致');
    if(!receipt?.id)throw Error('没有提交回执 ID，需人工平台核对，禁止重发');
    if(snapshot.media.some(x=>x.toLowerCase().endsWith('.mp4'))) {
      const video=this.video||new FacebookVideo(undefined,snapshot.credentialRef,snapshot.expectedIdentity);await video.connect(snapshot.targetPageId);
      const result=await video.get(receipt.id);
      if(!verifiedFacebookVideo(result,receipt.id,snapshot.targetPageId,snapshot.title,snapshot.body))throw Error('视频仍在处理或平台回读不匹配');
      return {verified:true,id:receipt.id,url:result.permalink_url,pageId:snapshot.targetPageId,targetPageId:snapshot.targetPageId,operatorActorId:snapshot.operatorActorId,identityEvidence:'API_TARGET_PAGE_AUTH',contentHash:snapshot.contentHash,method:'API_VIDEO_INDEPENDENT_READBACK'};
    }
    const auth=await this.client.call('fb_get_auth_status');assertFacebookReady(auth);if(String(auth.page_id)!==snapshot.targetPageId)throw Error('API 核对身份不匹配');
    const post=unwrap(await this.client.call('fb_get_post_details',{post_id:receipt.id}));
    if(String(post?.id)!==receipt.id||String(post?.from?.id)!==snapshot.targetPageId||clean(post?.message)!==clean(snapshot.body))throw Error('API 独立回读没有匹配身份和完整正文');
    return {verified:true,id:receipt.id,url:post.permalink_url||receipt.url,pageId:snapshot.targetPageId,targetPageId:snapshot.targetPageId,operatorActorId:snapshot.operatorActorId,identityEvidence:'API_TARGET_PAGE_AUTH',contentHash:snapshot.contentHash,method:'API_POST_INDEPENDENT_READBACK'};
  }
  async close(){await this.client.close();}
}

export class BrowserDriver {
  constructor(snapshot,facebook,{browser}={}){assertIdentities(snapshot);this.snapshot=snapshot;this.facebook=facebook;this.browser=browser||new FacebookBusinessBrowser({id:snapshot.accountId,display_name:snapshot.expectedIdentity,page_id:snapshot.targetPageId,page_name:snapshot.expectedIdentity,enabled:1,config_url:'',updated_at:''},snapshot.cdpPort,snapshot.operatorActorId);}
  async identity(){const checked=await this.facebook.inspect(this.snapshot.workspace,this.snapshot.accountId,{leaseHeld:true});if(!checked.healthy||checked.externalId!==this.snapshot.operatorActorId)throw Error('浏览器实际操作身份与任务不匹配');}
  async inspect(){await this.identity();return {healthy:true,externalId:this.snapshot.externalId};}
  async diagnose(snapshot,progress){
    await this.facebook.assertDiagnosticProfile(snapshot);await this.browser.connect();
    const context=this.browser.diagnosticContext();
    return runFacebookDiagnostic({context,snapshot,identity:()=>this.facebook.inspectDiagnostic(snapshot,context),progress});
  }
  async observeComposer(snapshot,progress){
    progress({kind:'COMPOSER_OBSERVATION',stage:'PROFILE_AND_CONNECTION',absenceProven:false});
    try{await boundedRead(()=>this.facebook.assertDiagnosticProfile(snapshot),4000);}catch{throw Error('OBSERVATION_PROFILE_MAPPING_OR_CONNECTION_BLOCKED');}
    try{await boundedRead(()=>this.browser.connect(),13000);}catch{throw Error('OBSERVATION_CONNECT_FAILED');}
    return observeRetainedComposer(this.browser.diagnosticContext(),snapshot,progress);
  }
  async closeDiagnostic(){await boundedDiagnosticCleanup(()=>this.browser.close(),4000);}
  async prepare(snapshot,assets,onWrite=()=>{}){
    await this.identity();await this.browser.connect();
    if(await this.browser.publishedMatch(snapshot.body))throw Error('平台已存在相同内容，未重复提交');
    onWrite();await this.browser.fill(snapshot.body,assets,{video:assets.some(x=>x.endsWith('.mp4')),title:snapshot.title});await this.identity();
    const form=await this.browser.readiness();
    return {operation:assets.some(x=>x.endsWith('.mp4'))?'FACEBOOK_BROWSER_VIDEO':'FACEBOOK_BROWSER_PAGE_POST',pageId:snapshot.targetPageId,targetPageId:snapshot.targetPageId,operatorActorId:snapshot.operatorActorId,mediaCount:assets.length,form};
  }
  async adoptPrepared(snapshot,assets){
    await this.identity();await this.browser.connect();
    if(await this.browser.publishedMatch(snapshot.body))throw Error('平台已存在相同内容，禁止继续旧编辑器');
    await this.browser.adoptPrepared(snapshot.body,assets);
    await this.identity();const form=await this.browser.readiness();
    return {operation:'FACEBOOK_BROWSER_PAGE_POST',pageId:snapshot.targetPageId,operatorActorId:snapshot.operatorActorId,mediaCount:assets.length,form,retainedComposer:true};
  }
  async submit(){await this.identity();await this.browser.submit({verifyIdentity:()=>this.identity()});return null;}
  async readback(snapshot){await this.identity();if(!this.browser.browser)await this.browser.connect();const post=await this.browser.readback(snapshot.body,{video:snapshot.media.some(x=>x.toLowerCase().endsWith('.mp4'))});return {verified:true,id:post.id,url:post.url,pageId:snapshot.targetPageId,targetPageId:snapshot.targetPageId,operatorActorId:snapshot.operatorActorId,identityEvidence:'BROWSER_ACTOR_AND_BUSINESS_ASSET',contentHash:snapshot.contentHash,method:'BROWSER_PUBLISHED_LIST_READBACK'};}
  async close(){await this.browser.close();}
  failureEvidence(){return this.browser.failureEvidence?.();}
}

export function unifiedDrivers(facebook) {
  return {create:async (snapshot,guards)=>{
    if(snapshot.transport==='BROWSER_SKILL')return new BrowserSkillPublicationDriver(snapshot,facebook.browserSkill,guards);
    if(snapshot.platform==='xiaohongshu')return new XiaohongshuPublishDriver(snapshot);
    if(snapshot.platform==='wechat_official_account')return new WechatDraftPublishDriver(snapshot);
    if(snapshot.platform==='wechat_channels')return new WechatChannelsPublishDriver(snapshot);
    if(snapshot.platform&&snapshot.platform!=='facebook')throw Error('平台执行器不存在');
    return snapshot.transport==='API'?new ApiDriver(snapshot):new BrowserDriver(snapshot,facebook);
  },pending:profileId=>facebook.resourcePending({id:profileId})};
}
