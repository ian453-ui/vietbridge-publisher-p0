export const publishingPlatforms=Object.freeze({
  facebook:{name:'Facebook',transports:['BROWSER','API'],outcome:'PUBLISHED'},
  xiaohongshu:{name:'小红书',transports:['MCP'],outcome:'PUBLISHED'},
  wechat_official_account:{name:'微信公众号草稿',transports:['API'],outcome:'DRAFT_WRITTEN'},
  wechat_channels:{name:'视频号',transports:['BROWSER'],outcome:'PUBLISHED_ID_PENDING'},
});
export function validatePlatformPayloadExtensions(platform,payload,extensions){
  if(!publishingPlatforms[platform])throw Error('发布平台无效');
  if(!Array.isArray(payload.tags)||payload.tags.some(x=>typeof x!=='string'||!x.trim()||/[#\n\r]/.test(x)))throw Error('话题字段格式无效');
  if(!payload.title.trim()&&platform!=='facebook')throw Error('该平台需要正式标题');
  if(!payload.body.trim())throw Error('正文不能为空');
  const media=extensions;const videos=media.filter(x=>x==='.mp4'),images=media.filter(x=>['.png','.jpg','.jpeg','.webp'].includes(x));
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
