import {basename} from 'node:path';
import {parse as parseYaml} from 'yaml';
import {XiaohongshuMcpConnector,findOwnFeed} from './publisher-core/xiaohongshu-mcp-connector.ts';
import {WenyanMcpConnector} from './publisher-core/wenyan-mcp-connector.ts';
import {WechatDraftReader,verifyWechatDraft} from './publisher-core/wechat-draft-reader.ts';
import {prepareWechatDraftMarkdown} from './publisher-core/publication-payloads.ts';
import {WechatChannelsDriver} from './publisher-core/wechat-channels-driver.ts';

const normalize=s=>String(s||'').replace(/\s+/gu,' ').trim();
const evidence=(snapshot,extra)=>({verified:true,platform:snapshot.platform,accountId:snapshot.externalId,pageId:snapshot.externalId,contentHash:snapshot.contentHash,payloadHash:snapshot.payloadHash,...extra});
const decode=text=>{try{return JSON.parse(text);}catch{throw Error('平台只读详情格式不可核实');}};

export class XiaohongshuPublishDriver {
  constructor(snapshot,{client}={}){this.snapshot=snapshot;this.client=client||new XiaohongshuMcpConnector(snapshot.options.mcp_endpoint);}
  async identity(){const login=await this.client.loginStatus();if(!login.loggedIn||login.accountId!==this.snapshot.externalId)throw Error('小红书登录或实际身份不匹配');}
  async inspect(){await this.identity();return {healthy:true,externalId:this.snapshot.externalId,readbackReady:(await this.client.readbackHealth()).ok};}
  async prepare(snapshot,assets){
    await this.identity();if(!(await this.client.readbackHealth()).ok)throw Error('小红书回读不可用，未提交');
    const old=await this.client.findPublished({accountId:snapshot.externalId,payloadFingerprint:snapshot.payloadHash,title:snapshot.title});
    if(old.status==='match')throw Error('当前账号已有同标题笔记，请先核对，未重复提交');
    const videos=assets.filter(x=>x.endsWith('.mp4'));
    this.input={title:snapshot.title,content:snapshot.body,tags:snapshot.payload.tags,visibility:'公开可见',products:[]};
    if(videos.length){this.operation='publish_with_video';this.input.video=videos[0];}
    else {this.operation='publish_content';this.input.images=assets;this.input.is_original=false;}
    return {operation:this.operation,accountId:snapshot.externalId};
  }
  async submit(){
    await this.identity();
    const result=this.operation==='publish_with_video'?await this.client.publishVideo(this.input):await this.client.publishImages(this.input);
    if(result.raw?.isError)throw Error('小红书提交结果不明确，请独立核对，禁止重发');
    const id=result.text?.match(/(?:PostID|note[_ ]?id|笔记ID)\s*[:：]?\s*([a-zA-Z0-9]+)/i)?.[1];
    return id?{id,url:`https://www.xiaohongshu.com/discovery/item/${id}`} : null;
  }
  async readback(snapshot,receipt){
    await this.identity();
    const raw=await this.client.readText('search_feeds',{keyword:snapshot.title,filters:{sort_by:'最新',publish_time:'不限',note_type:'不限',search_scope:'不限',location:'不限'}});
    const own=findOwnFeed(raw,snapshot.title,snapshot.externalId.replace(/^username:/,''));
    if(!own||!own.xsecToken||receipt?.id&&own.id!==receipt.id)throw Error('没有唯一的当前作者笔记与详情凭据，保留待核对');
    const rawDetail=decode(await this.client.readText('get_feed_detail',{feed_id:own.id,xsec_token:own.xsecToken,load_all_comments:false}));
    const detail=rawDetail.data||rawDetail,note=detail.note||detail;
    const author=String(note.user?.nickname||note.user?.nickName||'');
    if(String(note.noteId||note.note_id||note.id)!==own.id||author!==snapshot.externalId.replace(/^username:/,'')||normalize(note.title)!==normalize(snapshot.title)||normalize(note.desc||note.content)!==normalize(snapshot.body))throw Error('笔记详情没有匹配完整正文、标题和作者');
    return evidence(snapshot,{id:own.id,url:`https://www.xiaohongshu.com/discovery/item/${own.id}`,outcome:'PUBLISHED',method:'XHS_OWN_FEED_AND_FULL_DETAIL'});
  }
  async close(){await this.client.close();}
}

export function prepareDraft(snapshot,assets){
  // Only frozen approved media may reach the renderer, never arbitrary local files.
  let markdown=snapshot.body;
  const front=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let headingColor;
  if(front){const data=parseYaml(front[1]);if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['title','author','cover','heading_color'].includes(k)))throw Error('公众号元数据字段不受支持');headingColor=data.heading_color;if(headingColor!==undefined&&(typeof headingColor!=='string'||!/^#[0-9a-f]{6}$/i.test(headingColor)))throw Error('公众号标题颜色格式无效');}
  const locate=value=>{
    const exact=snapshot.media.indexOf(value);if(exact>=0)return assets[exact];
    const indexes=snapshot.media.map((p,i)=>basename(p)===basename(value)?i:-1).filter(i=>i>=0);
    if(indexes.length!==1)throw Error('公众号引用了未批准或有歧义的图片');return assets[indexes[0]];
  };
  markdown=markdown.replace(/(!\[[^\]]*\]\()<?([^)>\n]+)>?(\))/gu,(_,prefix,path,suffix)=>prefix+'<'+locate(path)+'>'+suffix);
  const records=assets.map((path,i)=>({staging_path:path,original_locator:snapshot.media[i],filename:basename(snapshot.media[i]),mime_detected:'image/'+(path.endsWith('.png')?'png':'jpeg'),role:i?'gallery_image':'cover',ordinal:i}));
  // No existing frontmatter can override the frozen cover/title/author.
  const body=front?markdown.slice(markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0].length):markdown;
  const metadata='---\ntitle: '+JSON.stringify(snapshot.title)+'\nauthor: '+JSON.stringify(snapshot.payload.author)+'\ncover: '+JSON.stringify(assets[0])+(headingColor?'\nheading_color: '+JSON.stringify(headingColor):'')+'\n---\n';
  return prepareWechatDraftMarkdown(metadata+body,snapshot.title,records);
}
export class WechatDraftPublishDriver {
  constructor(snapshot,{reader,client}={}){
    this.snapshot=snapshot;
    this.reader=reader||new WechatDraftReader(fetch,{configPath:snapshot.credentialRef,expectedAppId:snapshot.externalId});
    this.client=client||new WenyanMcpConnector({configPath:snapshot.credentialRef,expectedAppId:snapshot.externalId,entry:snapshot.options.connector_entry||'/Users/a1-6/claude/wechat-mcp/wenyan-mcp-2.0.3/dist/index.js'});
  }
  async identity(){if(await this.reader.identity()!==this.snapshot.externalId)throw Error('公众号实际授权与任务身份不匹配');}
  async inspect(){await this.identity();await this.reader.list(0);return {healthy:true,externalId:this.snapshot.externalId,draftOnly:true};}
  async prepare(snapshot,assets){
    this.markdown=prepareDraft(snapshot,assets);await this.identity();
    if((await this.client.call('list_themes')).isError)throw Error('公众号渲染预检失败');
    const list=await this.reader.list(0);
    if(!Array.isArray(list.item))throw Error('公众号草稿预检格式无效');
    if(list.item.some(item=>verifyWechatDraft(this.markdown,item.content)))throw Error('已有相同草稿，请先核对，未重复创建');
    return {operation:'WECHAT_DRAFT_CREATE',accountId:snapshot.externalId};
  }
  async submit(){
    await this.identity();const result=await this.client.call('publish_article',{content:this.markdown,theme_id:'default'});
    const id=result.text.match(/media ID is\s+([^\s.]+)/i)?.[1];
    if(result.isError||!id)throw Error('公众号草稿返回不明确，保留待核对，禁止重复上传');
    return {id,url:''};
  }
  async readback(snapshot,receipt){
    await this.identity();
    // Regenerate only from persisted frozen assets supplied by the executor.
    if(!this.markdown)throw Error('缺少已冻结的草稿正文，不能核对');
    let id=receipt?.id;
    if(!id){const list=await this.reader.list(0),matches=(list.item||[]).filter(x=>verifyWechatDraft(this.markdown,x.content));if(matches.length!==1)throw Error('未找到唯一匹配草稿，不能证明不存在');id=String(matches[0].media_id);}
    if(!verifyWechatDraft(this.markdown,await this.reader.get(id)))throw Error('公众号草稿标题、作者、封面或正文不一致');
    return evidence(snapshot,{id,outcome:'DRAFT_WRITTEN',formalPublication:false,method:'WECHAT_DRAFT_DETAIL_READBACK'});
  }
  restore(snapshot,assets){this.markdown=prepareDraft(snapshot,assets);}
  async close(){await this.client.close();}
}

export class WechatChannelsPublishDriver {
  constructor(snapshot,{browser}={}){
    this.snapshot=snapshot;
    this.browser=browser||new WechatChannelsDriver(snapshot.profileDir,{accountId:snapshot.externalId,displayName:snapshot.expectedIdentity,collection:snapshot.options.collection||'',port:snapshot.cdpPort,profileIdentityConfirmed:snapshot.options.profile_identity_confirmed===true});
  }
  async inspect(){const result=await this.browser.preflight();return {healthy:result.ok,externalId:result.ok?this.snapshot.externalId:null,reason:result.reason,identityEvidence:result.identityEvidence};}
  async prepare(snapshot,assets,onWrite=()=>{}){
    const check=await this.browser.preflight();if(!check.ok)throw Error('视频号预检失败：'+check.reason);
    this.beforeCount=check.beforeCount;this.description=snapshot.body+'\n\n'+snapshot.payload.tags.map(x=>'#'+x).join(' ');
    if(await this.browser.findExisting(snapshot.title,this.description))throw Error('视频号已存在相同正文，未重复提交');
    onWrite();const form=await this.browser.prepare({videoPath:assets[0],title:snapshot.title,description:this.description,beforeCount:this.beforeCount});
    await this.browser.assertIdentity();
    return {operation:'WECHAT_CHANNELS_PUBLISH',accountId:snapshot.externalId,beforeCount:this.beforeCount,title:form.title,description:form.description};
  }
  async submit(){await this.browser.assertIdentity();await this.browser.submitOnce();return null;}
  restore(snapshot,assets,prepared){this.beforeCount=prepared?.beforeCount;this.description=snapshot.body+'\n\n'+snapshot.payload.tags.map(x=>'#'+x).join(' ');}
  async readback(snapshot){
    await this.browser.assertIdentity();const result=await this.browser.readback({expectedTitle:snapshot.title,expectedDescription:this.description,beforeCount:this.beforeCount});
    if(result.outcome!=='PUBLISHED_ID_PENDING')throw Error('视频号列表回读不明确，禁止重发');
    return evidence(snapshot,{outcome:'PUBLISHED_ID_PENDING',publicLinkUnavailable:true,method:'CHANNELS_OWN_LIST_READBACK',identityEvidence:snapshot.options.profile_identity_confirmed?'USER_ATTESTED_MANAGED_PROFILE':'PAGE_TEXT',details:result.evidence});
  }
  async close(){await this.browser.close();}
}
