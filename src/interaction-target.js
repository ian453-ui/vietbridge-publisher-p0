const hosts=new Set(['facebook.com','www.facebook.com','m.facebook.com','mbasic.facebook.com']);
const numeric=value=>/^[1-9]\d*$/.test(String(value||''));
export function interactionError(code,message){return Object.assign(new Error(message),{code});}
const deny=message=>{throw interactionError('INVALID_INTERACTION_TARGET',message);};
/** A numeric group ID may replace a vanity slug only after that ID is stored on the exact group row. */
export function verifiedProactiveGroupUrl(group){
  let url;try{url=new URL(group?.url||'');}catch{deny('群组地址无效');}
  const slug=url.pathname.match(/^\/groups\/([^/]+)\/?$/)?.[1],external=String(group?.external_id||'');
  if(url.protocol!=='https:'||!hosts.has(url.hostname)||!slug||!external)deny('群组归属不完整');
  if(external===slug)return `https://www.facebook.com/groups/${slug}`;
  if(numeric(external)&&!numeric(slug))return `https://www.facebook.com/groups/${external}`;
  deny('群组别名与数字 ID 未可靠绑定');
}
/** Canonicalize observed links only. Never use a group home or local UUID as a post. */
export function facebookPostTarget(value,{externalId,groupUrl,commentId,parentCommentId}={}){
  let url;try{url=new URL(String(value));}catch{deny('缺少可核验的真实帖子链接');}
  if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.username||url.password||url.port)deny('帖子链接不是受支持的 Facebook HTTPS 地址');
  let match=url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([1-9]\d*)\/?$/),groupId=match?.[1],postId=match?.[2],ownerId;
  if(!postId){match=url.pathname.match(/^\/([^/]+)\/posts\/([1-9]\d*)\/?$/);if(match){ownerId=match[1];postId=match[2];}}
  if(!postId&&['/permalink.php','/story.php'].includes(url.pathname)){postId=url.searchParams.get('story_fbid');ownerId=url.searchParams.get('id');if(groupUrl){groupId=ownerId;ownerId=undefined;}}
  if(!postId&&/^\/photo\/?$/.test(url.pathname)&&groupUrl){postId=url.searchParams.get('set')?.match(/^gm\.([1-9]\d*)$/)?.[1];groupId=url.searchParams.get('idorvanity');}
  if(!numeric(postId)||(!groupId&&!ownerId))deny('链接没有稳定的真实帖子 ID');
  if(groupUrl){let expected;try{const g=new URL(groupUrl);if(!hosts.has(g.hostname)||g.protocol!=='https:')deny('群组地址无效');expected=g.pathname.match(/^\/groups\/([^/]+)\/?$/)?.[1];}catch{deny('群组地址无效');}if(!expected||expected!==groupId)deny('帖子链接不属于冻结目标群组');}
  if(externalId!==undefined){const id=String(externalId),parts=id.match(/^([1-9]\d*)_([1-9]\d*)$/),expected=parts?.[2]||id;if(!numeric(expected)||postId!==expected||parts&&ownerId!==parts[1])deny('真实帖子 ID 与来源链接不一致');}
  if(commentId!==undefined&&!numeric(commentId))deny('评论没有稳定的真实 ID');
  if(parentCommentId&&!numeric(parentCommentId))deny('父评论没有稳定的真实 ID');
  const permalink=groupId?`https://www.facebook.com/groups/${groupId}/posts/${postId}/`:`https://www.facebook.com/${ownerId}/posts/${postId}/`;
  const target=new URL(permalink);if(commentId){target.searchParams.set('comment_id',parentCommentId||commentId);if(parentCommentId)target.searchParams.set('reply_comment_id',commentId);}
  return {postId,groupId:groupId||null,ownerId:ownerId||null,commentId:commentId||null,parentCommentId:parentCommentId||null,permalink,url:target.href,budgetKey:`post:${postId}`};
}
/** Facebook sometimes replaces a numeric Page story ID with an opaque pfbid in comment links. */
export function facebookCommentAnchorBoundToPost(value,target,commentId){
  let url;try{url=new URL(String(value));}catch{return false;}
  if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.username||url.password||url.port||url.searchParams.get('comment_id')!==String(commentId))return false;
  try{if(facebookPostTarget(url.href).permalink===target.permalink)return true;}catch{}
  return Boolean(target.ownerId&&url.pathname==='/permalink.php'&&url.searchParams.get('id')===target.ownerId&&/^pfbid[A-Za-z0-9]+$/.test(url.searchParams.get('story_fbid')||''));
}
