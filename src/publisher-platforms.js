import {extname} from 'node:path';

import {publishingPlatforms,validatePlatformPayloadExtensions} from './publisher-platform-policy.js';
export {publishingPlatforms} from './publisher-platform-policy.js';
export const terminalStates=['PUBLISHED','DRAFT_WRITTEN','PUBLISHED_ID_PENDING'];
export const guardedStates=['PREPARING','SUBMITTING','UNKNOWN',...terminalStates];
export const platformOf=s=>s.platform||'facebook';
export function validatePlatformPayload(platform,payload,media){return validatePlatformPayloadExtensions(platform,payload,media.map(x=>extname(x).toLowerCase()));}
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
