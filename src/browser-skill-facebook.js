import {assertBrowserSkillBinding} from './browser-skill-binding.js';
import {facebookPostTarget} from './interaction-target.js';
import {normalizeProactiveResults} from './facebook-browser.js';

const fail=code=>{throw Error(code);};
const norm=text=>String(text||'').replace(/\s+/g,' ').trim();
const warning=/checkpoint|login challenge|temporarily blocked|suspicious activity|security check|restricted|安全验证|访问受限/i;

// Read-only DOM fallback after semantic observe: only rendered text, public
// links, controls and post timestamps. No storage, cookies, private API/modules.
export function readFacebookDocument({groupId=null,postId=null,replyBody='',selector=null}={}){
 const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'),text=e=>visible(e)?(e.innerText||e.textContent||'').trim():'';
 const publicLink=a=>{try{const u=new URL(a.href);if(!['facebook.com','www.facebook.com','business.facebook.com'].includes(u.hostname))return null;const clean=new URL(u.origin+u.pathname);for(const k of ['id','asset_id','story_fbid','comment_id','reply_comment_id','set','idorvanity'])if(u.searchParams.has(k))clean.searchParams.set(k,u.searchParams.get(k));return {url:clean.href,text:text(a),label:a.getAttribute('aria-label')||''};}catch{return null;}};
 const links=e=>[...e.querySelectorAll('a[href]')].filter(visible).map(publicLink).filter(Boolean),navLinks=[...document.querySelectorAll('header a[href],nav a[href],[role="banner"] a[href],[role="navigation"] a[href]')].filter(visible).map(publicLink).filter(Boolean);
 const controlSelector=e=>{const parts=[];for(let node=e;node&&node.nodeType===1;node=node.parentElement){const tag=node.tagName.toLowerCase(),siblings=node.parentElement?[...node.parentElement.children].filter(s=>s.tagName===node.tagName):[node];parts.unshift(tag+':nth-of-type('+(siblings.indexOf(node)+1)+')');}return parts.join(' > ');};
 const canonical=l=>{try{const u=new URL(l.url),m=u.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([1-9]\d*)\/?$/);return m&&m[1]===groupId?`https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/`:null;}catch{return null;}};
 const articles=[...document.querySelectorAll('[role="article"]')].filter(visible),rows=[];
 for(const card of articles){
  const ownLinks=links(card),postLinks=ownLinks.filter(l=>canonical(l));if(!postLinks.length)continue;
  const targetIds=new Set(postLinks.map(l=>canonical(l)));if(targetIds.size!==1)continue;
  const messages=[...card.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"]')].filter(e=>visible(e)&&e.closest('[role="article"]')===card);
  if(messages.length!==1)continue;
  const times=[...card.querySelectorAll('time,abbr,[data-utime]')].filter(visible).flatMap(e=>[e.getAttribute('datetime'),e.getAttribute('data-utime'),e.getAttribute('title'),text(e)]).filter(Boolean);
  rows.push({body:text(messages[0]),links:ownLinks,time:null,times:[...postLinks.flatMap(l=>[l.text,l.label]),...times]});
 }
 let target=null;
 if(postId){
  const matches=articles.filter(a=>[...a.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"]')].filter(e=>visible(e)&&e.closest('[role="article"]')===a).length===1&&links(a).some(l=>canonical(l)===`https://www.facebook.com/groups/${groupId}/posts/${postId}/`));
  if(matches.length===1){
   const a=matches[0],row=rows.filter(r=>r.links.some(l=>canonical(l)===`https://www.facebook.com/groups/${groupId}/posts/${postId}/`));
   const boxes=[...a.querySelectorAll('[role="textbox"][contenteditable="true"]')].filter(e=>visible(e)&&e.closest('[role="article"]')===a);
   const buttons=[...a.querySelectorAll('[role="button"]')].filter(e=>visible(e)&&e.closest('[role="article"]')===a).map(e=>({label:e.getAttribute('aria-label')||text(e),selector:controlSelector(e)}));
   const comments=[];
   for(const c of a.querySelectorAll('[role="article"]')){
    if(!visible(c)||!text(c).includes(replyBody)||!replyBody)continue;
    const bodyNodes=[...c.querySelectorAll('[dir="auto"]')].filter(e=>visible(e)&&e.closest('[role="article"]')===c&&text(e).replace(/\s+/g,' ').trim()===replyBody.replace(/\s+/g,' ').trim());
    if(bodyNodes.length!==1)continue;const cl=links(c);comments.push({body:text(bodyNodes[0]),links:cl});
   }
   target={body:row.length===1?row[0].body:null,boxCount:boxes.length,boxText:boxes.length===1?text(boxes[0]):null,boxSelector:boxes.length===1?controlSelector(boxes[0]):null,buttons,comments};
  }
 }
 return {url:location.href,visibleText:text(document.body).slice(0,20000),navLinks,rows,target,selectorCount:selector?[...document.querySelectorAll(selector)].filter(visible).length:null};
}
export function observedIdentity(doc,binding){
 const actorIds=new Set(),pages=new Set();
 for(const link of doc.navLinks||[]){const u=new URL(link.url),actor=u.pathname.match(/^\/([1-9]\d*)\/ad_center\/?$/)?.[1];if(actor)actorIds.add(actor);if(u.hostname==='business.facebook.com'&&u.pathname==='/latest/inbox/all/'&&u.searchParams.get('asset_id'))pages.add(u.searchParams.get('asset_id'));}
 if(actorIds.size!==1||!actorIds.has(binding.actor_id)||pages.size!==1||!pages.has(binding.target_page_id))fail('BSK_VISIBLE_ACTOR_AND_PAGE_NOT_VERIFIED');
 return {actorId:binding.actor_id,targetPageId:binding.target_page_id};
}
export function readbackEvidence(doc,target,action,replyBody,binding){
 observedIdentity(doc,binding);
 if(facebookPostTarget(doc.url,{groupUrl:`https://www.facebook.com/groups/${target.groupId}/`}).permalink!==target.permalink||!doc.target)fail('BSK_FRESH_TARGET_READBACK_REQUIRED');
 if(action.action_type==='LIKE'){
  const unlike=doc.target.buttons.filter(b=>/^(Unlike|Bỏ thích|取消赞)$/i.test(b.label));if(unlike.length!==1)fail('BSK_LIKE_READBACK_NOT_PROVEN');
  return {readback_verified:true,liked:true,actor_id:binding.actor_id,post_url:target.permalink,method:'BROWSER_SKILL_FRESH_OWNED_TAB',checked_at:new Date().toISOString()};
 }
 const matches=(doc.target.comments||[]).filter(c=>norm(c.body)===norm(replyBody)).flatMap(c=>{
  const authors=c.links.filter(l=>{const u=new URL(l.url);return u.pathname===`/${binding.actor_id}`||u.pathname===`/groups/${target.groupId}/user/${binding.actor_id}/`||u.pathname==='/profile.php'&&u.searchParams.get('id')===binding.actor_id;});if(!authors.length)return [];
  return c.links.flatMap(l=>{try{const u=new URL(l.url),id=u.searchParams.get('comment_id');if(!/^[1-9]\d*$/.test(id||'')||u.searchParams.has('reply_comment_id'))return [];const verified=facebookPostTarget(l.url,{groupUrl:`https://www.facebook.com/groups/${target.groupId}/`});if(verified.postId!==target.postId)return [];return [{comment_id:id,comment_url:facebookPostTarget(target.permalink,{commentId:id}).url}];}catch{return [];}});
 });
 const unique=[...new Map(matches.map(m=>[m.comment_id,m])).values()];if(unique.length!==1)fail('BSK_EXACT_REPLY_AUTHOR_ID_READBACK_REQUIRED');
 return {readback_verified:true,replied:true,author_verified:true,actor_id:binding.actor_id,...unique[0],post_url:target.permalink,method:'BROWSER_SKILL_FRESH_OWNED_TAB',checked_at:new Date().toISOString()};
}

export class BrowserSkillFacebook{
 constructor(store,{binding,client,approvedGroupIds=null,now=()=>Date.now()}={}){this.store=store;this.binding=structuredClone(binding);this.client=client;this.approvedGroupIds=approvedGroupIds?new Set(approvedGroupIds):null;this.now=now;this.active=false;}
 matches(workspace,accountId){return workspace===this.binding.workspace&&accountId===this.binding.account_id;}
 current(){return assertBrowserSkillBinding(this.store.db,this.binding,{now:this.now()});}
 capability(workspace,accountId){try{
  if(!this.matches(workspace,accountId))return null;this.current();const settings=this.store.proactiveSettings(workspace,accountId),count=this.store.db.prepare("SELECT count(*) n FROM facebook_groups WHERE workspace=? AND account_id=? AND enabled=1 AND membership_status='JOINED' AND proactive_engagement_enabled=1").get(workspace,accountId).n;
  return {available:true,accountId,instanceId:this.binding.browser_instance_id,expiresAt:new Date(this.binding.expires_at).toISOString(),canScan:Boolean(settings?.enabled&&settings.global_enabled&&settings.account_enabled&&count>0&&count<=2&&settings.daily_limit<=3&&settings.max_followups<=5&&settings.lookback_hours<=24&&settings.max_posts_per_group<=10),grantsPlatformExecution:false};
 }catch(e){return {available:false,accountId,canScan:false,reason:e.message,grantsPlatformExecution:false};}}
 async start(){if(this.active)fail('BSK_RESOURCE_BUSY');this.current();this.active=true;try{return await this.client.start(this.binding.browser_instance_id);}catch(e){this.active=false;throw e;}}
 async stop(session){try{if(session)await this.client.stop(session);}finally{this.active=false;}}
 async document(session,tab,args){this.current();await this.client.observe(session,tab);const doc=await this.client.read(session,tab,readFacebookDocument,args);if(warning.test(doc.url+' '+doc.visibleText)||/\/login\/?|\/checkpoint\//i.test(doc.url))fail('BSK_PLATFORM_WARNING_STOP');return doc;}
 async targetDocument(session,tab,target,replyBody,selector){const doc=await this.document(session,tab,{groupId:target.groupId,postId:target.postId,replyBody,selector});observedIdentity(doc,this.binding);if(facebookPostTarget(doc.url,{groupUrl:`https://www.facebook.com/groups/${target.groupId}/`}).permalink!==target.permalink||!doc.target)fail('BSK_UNIQUE_TARGET_REQUIRED');return doc;}
 async scan(workspace,accountId){
  if(!this.matches(workspace,accountId))fail('BSK_ACCOUNT_MISMATCH');const settings=this.store.proactiveSettings(workspace,accountId),groups=this.store.db.prepare("SELECT * FROM facebook_groups WHERE workspace=? AND account_id=? AND enabled=1 AND membership_status='JOINED' AND proactive_engagement_enabled=1").all(workspace,accountId);
  if(this.approvedGroupIds&&groups.some(g=>!this.approvedGroupIds.has(g.id)))fail('BSK_OUTSIDE_APPROVED_GROUPS');
  if(!settings?.enabled||!settings.global_enabled||!settings.account_enabled||!groups.length||groups.length>2||settings.daily_limit>3||settings.max_followups>5||settings.lookback_hours>24||settings.max_posts_per_group>10)fail('BSK_BOUNDED_EXISTING_SETTINGS_REQUIRED');
  let session;try{
   session=await this.start();const tab=await this.client.tab(session,'https://www.facebook.com/professional_dashboard/content/content_library/'),identity=observedIdentity(await this.document(session,tab,{}),this.binding),found=[];let observed=0;
   for(const group of groups){const url=new URL(group.url),groupId=url.pathname.match(/^\/groups\/([1-9]\d*)\/?$/)?.[1];if(!groupId||url.hostname!=='www.facebook.com'||url.protocol!=='https:')fail('BSK_REAL_GROUP_REQUIRED');
    await this.client.navigate(session,tab,group.url+'?sorting_setting=CHRONOLOGICAL');const doc=await this.document(session,tab,{groupId});observedIdentity(doc,this.binding);
    if(new URL(doc.url).pathname.match(/^\/groups\/([^/]+)/)?.[1]!==groupId||!doc.rows.length)fail('BSK_GROUP_POST_READ_FAILED');
    const rows=doc.rows.slice(0,settings.max_posts_per_group);observed+=rows.length;found.push(...normalizeProactiveResults(rows,group,settings.lookback_hours,this.now()));
   }
   this.current();this.store.ingestEngagementPosts(workspace,accountId,found);const items=this.store.rankedEngagementCandidates(workspace,accountId);return {identity,groups:groups.length,observed,scanned:found.length,candidates:items.length,items,transport:'BROWSER_SKILL',instanceId:this.binding.browser_instance_id};
  }finally{await this.stop(session);}
 }
 async execute(workspace,id,replyBody,{scopedPlan,assertScoped}={}){
  if(!scopedPlan||typeof assertScoped!=='function')fail('BSK_EXISTING_SCOPED_PLAN_REQUIRED');
  const post=this.store.proactivePost(workspace,id);if(!this.matches(workspace,post.account_id))fail('BSK_ACCOUNT_MISMATCH');const group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE workspace=? AND id=?').get(workspace,post.group_id),target=facebookPostTarget(post.permalink,{externalId:post.external_id,groupUrl:group?.url});
  if(!group?.enabled||group.membership_status!=='JOINED'||!group.proactive_engagement_enabled||!target.groupId)fail('BSK_EXISTING_JOINED_OPT_IN_REQUIRED');
  let session,currentAction,submitted=false;
  try{
   assertScoped();session=await this.start();const tab=await this.client.tab(session,target.permalink),results=[];
   for(const action of scopedPlan.actions){
    currentAction=action;submitted=false;if(action.state!=='ATTEMPTING'||action.post_id!==id)fail('BSK_EXACT_RESERVED_ACTION_REQUIRED');
    assertScoped();this.store.assertProactiveActionScope(workspace,action.id);
    const doc=await this.targetDocument(session,tab,target,replyBody);if(norm(doc.target.body)!==norm(post.body))fail('BSK_FROZEN_SOURCE_BODY_CHANGED');
    let selector;
    if(action.action_type==='LIKE'){
     const controls=doc.target.buttons.filter(b=>/^(Like|Thích|赞|点赞|Unlike|Bỏ thích|取消赞)$/i.test(b.label));if(controls.length!==1||/^(Unlike|Bỏ thích|取消赞)$/i.test(controls[0].label))fail('BSK_LIKE_CONTROL_UNIQUE_OR_ALREADY_LIKED');
     // Exact observed label, constrained to the one verified target article.
     selector=controls[0].selector;
    }else if(action.action_type==='INITIAL_REPLY'){
     if(doc.target.boxCount!==1)fail('BSK_UNIQUE_REPLY_BOX_REQUIRED');selector=doc.target.boxSelector;
    }else fail('BSK_UNSUPPORTED_RESERVED_ACTION');
    const exactControl=d=>d.selectorCount===1&&(action.action_type==='INITIAL_REPLY'?d.target.boxCount===1&&d.target.boxSelector===selector:d.target.buttons.filter(b=>b.selector===selector&&/^(Like|Thích|赞|点赞)$/i.test(b.label)).length===1);
    let checked=await this.targetDocument(session,tab,target,replyBody,selector);if(!exactControl(checked))fail('BSK_UNIQUE_CONTROL_REQUIRED');
    if(action.action_type==='INITIAL_REPLY'){
     await this.client.input(session,tab,'fill',selector,replyBody);checked=await this.targetDocument(session,tab,target,replyBody,selector);if(!exactControl(checked)||norm(checked.target.boxText)!==norm(replyBody))fail('BSK_REPLY_TEXT_OR_CONTROL_CHANGED');
    }
    if(norm(checked.target.body)!==norm(post.body))fail('BSK_FROZEN_SOURCE_BODY_CHANGED');assertScoped();this.current();this.store.assertProactiveActionScope(workspace,action.id);
    // Set BEFORE dispatch. A timeout, lost daemon or readback error can never
    // release the spent permit/quota or cause a second submission.
    submitted=true;await this.client.input(session,tab,action.action_type==='LIKE'?'click':'press',selector,action.action_type==='LIKE'?undefined:'Enter');
    const fresh=await this.client.tab(session,target.permalink);let evidence;try{evidence=readbackEvidence(await this.targetDocument(session,fresh,target,replyBody),target,action,replyBody,this.binding);}finally{await this.client.closeTab(session,fresh).catch(()=>{});}
    results.push(this.store.finishProactiveAction(workspace,action.id,evidence));currentAction=null;
   }
   return {decision:scopedPlan.decision,actions:results,transport:'BROWSER_SKILL'};
  }catch(error){
   if(warning.test(String(error)))this.store.db.prepare("UPDATE facebook_accounts SET session_health='RESTRICTED' WHERE workspace=? AND id=?").run(workspace,post.account_id);
   if(currentAction&&submitted)return this.store.markProactiveUnknown(workspace,currentAction.id,String(error));
   this.store.failProactiveBeforeSubmit(workspace,id,String(error));throw error;
  }finally{await this.stop(session).catch(()=>{});}
 }
}
