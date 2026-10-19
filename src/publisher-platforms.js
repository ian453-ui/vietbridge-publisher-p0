import {extname} from 'node:path';

export const publishingPlatforms=Object.freeze({
  facebook:{name:'Facebook',transports:['BROWSER','API'],outcome:'PUBLISHED'},
  xiaohongshu:{name:'小红书',transports:['MCP'],outcome:'PUBLISHED'},
  wechat_official_account:{name:'微信公众号草稿',transports:['API'],outcome:'DRAFT_WRITTEN'},
  wechat_channels:{name:'视频号',transports:['BROWSER'],outcome:'PUBLISHED_ID_PENDING'},
});
export const terminalStates=['PUBLISHED','DRAFT_WRITTEN','PUBLISHED_ID_PENDING'];
export const guardedStates=['PREPARING','SUBMITTING','UNKNOWN',...terminalStates];
export const platformOf=s=>s.platform||'facebook';
export function validatePlatformPayload(platform,payload,media){
  if(!publishingPlatforms[platform])throw Error('发布平台无效');
  if(!Array.isArray(payload.tags)||payload.tags.some(x=>typeof x!=='string'||!x.trim()||/[#\n\r]/.test(x)))throw Error('话题字段格式无效');
  if(!payload.title.trim()&&platform!=='facebook')throw Error('该平台需要正式标题');
  if(!payload.body.trim())throw Error('正文不能为空');
  const videos=media.filter(x=>extname(x).toLowerCase()==='.mp4'),images=media.filter(x=>['.png','.jpg','.jpeg','.webp'].includes(extname(x).toLowerCase()));
  if(platform!=='facebook'&&images.length+videos.length!==media.length||videos.length>1||videos.length&&images.length)throw Error('媒体格式不支持，或视频与图片混用');
  if(platform==='xiaohongshu'){
    if(!media.length)throw Error('小红书需要图片或视频');
    if([...payload.title].length>20)throw Error('小红书标题超过20字；请修改并重新确认');
    if(/^\s*#\S/m.test(payload.body))throw Error('小红书话题请放在独立话题字段');
  }
  if(platform==='wechat_channels'){
    if(videos.length!==1)throw Error('视频号需要单个 MP4');
    if([...payload.title].length>16)throw Error('视频号标题超过16字；不会自动截断');
    if([...payload.body+'\n\n'+payload.tags.map(x=>'#'+x).join(' ')].length>600)throw Error('视频号正文与话题超过600字预算');
    if(!payload.tags.length)throw Error('视频号需要话题');
  }
  if(platform==='wechat_official_account'&&(videos.length||!images.length))throw Error('公众号草稿需要图片封面；视频请选择单独的伴随文章');
}
export function publicOptions(platform,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('账号配置格式无效');
  const allowed=platform==='xiaohongshu'?['mcp_endpoint']:platform==='wechat_official_account'?['connector_entry']:platform==='wechat_channels'?['collection','profile_identity_confirmed']:[];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw Error('仅接受本机连接引用与非秘密配置；不能填写令牌或密码');
  const options={...input};
  if(platform==='xiaohongshu'){
    options.mcp_endpoint=options.mcp_endpoint||'http://127.0.0.1:18060/mcp';
    const url=new URL(options.mcp_endpoint);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/mcp'||url.search||url.hash||url.username||url.password||!url.port)throw Error('小红书 MCP 仅接受已配置的 loopback /mcp 端点');
    options.mcp_endpoint=url.href;
  }
  if(options.connector_entry&&(!options.connector_entry.startsWith('/')||!options.connector_entry.endsWith('.js')))throw Error('公众号连接器入口必须是已有本机 JS 绝对路径');
  if(options.collection!==undefined&&typeof options.collection!=='string')throw Error('视频号合集名称格式无效');
  if(options.profile_identity_confirmed!==undefined&&typeof options.profile_identity_confirmed!=='boolean')throw Error('专用窗口身份确认必须为布尔值');
  return options;
}

export function retainsPreparationEffects(job){const evidence=job.evidence||JSON.parse(job.evidence_json||'{}');return Boolean((evidence.preparationResolution||evidence.preparationFailure)&&evidence.preparationEffectsMayRemain===true);}
