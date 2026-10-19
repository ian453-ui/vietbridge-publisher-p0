import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {observedIdentity} from './browser-skill-facebook.js';

const fail=code=>{throw Error(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function observedPublicationTime(value){
 const s=norm(value),month='(?:January|February|March|April|May|June|July|August|September|October|November|December)',clock='(?: at)? \\d{1,2}:\\d{2}(?: ?[AP]M)?';
 return /^(?:just now|yesterday|\d{1,3}\s?(?:m|min|mins|h|hr|hrs|d|w|y)(?: ago)?)$/i.test(s)||/^\d{10}$/.test(s)||/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)&&Number.isFinite(Date.parse(s))||new RegExp('^(?:\\d{1,2} '+month+'(?:,? \\d{4})?|'+month+' \\d{1,2}(?:,? \\d{4})?)'+clock+'$','i').test(s);
}
const publicationEpoch=value=>/^\d{10}$/.test(String(value))?Number(value)*1000:/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(String(value))?Date.parse(value):NaN;
export function publicationReference(adapter,account){
 const b=adapter.binding,current=adapter.current();
 if(!adapter.matches(account.workspace,account.id)||account.publisher_transport!=='BROWSER'||account.identity_type!=='PAGE'||account.external_id!==b.actor_id||account.operator_actor_id!==b.actor_id||account.target_page_id!==b.target_page_id)fail('BSK_PUBLICATION_ACCOUNT_REQUIRED');
 return {transport:'BROWSER_SKILL',profileId:current.profileId,profileDir:null,cdpPort:null,credentialRef:null,executionRef:{kind:'BROWSER_SKILL',instanceId:current.instanceId,bindingHash:current.fingerprint}};
}
export function assertPublicationReference(snapshot,adapter,account){
 if(!adapter)fail('BSK_PUBLICATION_ADAPTER_REQUIRED');const expected=publicationReference(adapter,account);
 if(['transport','profileId','profileDir','cdpPort','credentialRef'].some(k=>snapshot[k]!==expected[k])||JSON.stringify(snapshot.executionRef)!==JSON.stringify(expected.executionRef))fail('BSK_PUBLICATION_BINDING_MISMATCH');
 return expected;
}
export function publicationMedia(media){
 if(!Array.isArray(media)||media.length!==1||!/\.(png|jpe?g|webp)$/i.test(media[0]||''))fail('BSK_REVIEWED_SINGLE_IMAGE_REQUIRED');
 const bytes=readFileSync(media[0]);if(!bytes.length)fail('BSK_EMPTY_MEDIA');return [{ordinal:0,sha256:hash(bytes),size:bytes.length}];
}
export function publicationAuthor(row,groupUrl){
 const evidence=row.author;if(evidence?.source!=='MAIN_POST_AUTHOR_HEADING'||evidence.regionCount!==1||!Array.isArray(evidence.links)||evidence.links.length!==1)return null;
 try{const u=new URL(evidence.links[0].url),groupId=new URL(groupUrl).pathname.split('/')[2];if(u.protocol!=='https:'||!['www.facebook.com','facebook.com'].includes(u.hostname)||u.username||u.password||u.hash)return null;
  let id;if(u.pathname==='/profile.php'&&[...u.searchParams.keys()].every(k=>k==='id'))id=u.searchParams.get('id');else if(!u.search)id=u.pathname.match(/^\/([1-9]\d*)\/?$/)?.[1]||u.pathname.match(new RegExp('^/groups/'+groupId+'/user/([1-9]\\d*)/?$'))?.[1];
  return /^[1-9]\d*$/.test(id||'')?{id,url:u.href,source:evidence.source}:null;
 }catch{return null;}
}
// Visible DOM/public links only. No Graph, storage, credentials or DOM writes.
export function readPublicationDocument(){
 const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const text=e=>visible(e)?(e.innerText||e.textContent||'').trim():'';
 const links=(e,article=null)=>[...e.querySelectorAll('a[href]')].filter(a=>visible(a)&&(e.getAttribute('role')!=='article'||a.closest('[role="article"]')===e)&&(!article||a.closest('[role="article"]')===article&&!a.closest('blockquote,[data-ad-preview="message"],[data-ad-comet-preview="message"]'))).flatMap(a=>{try{const u=new URL(a.href);if(!['www.facebook.com','facebook.com','business.facebook.com'].includes(u.hostname))return [];const clean=new URL(u.origin+u.pathname);for(const k of ['id','asset_id','story_fbid'])if(u.searchParams.has(k))clean.searchParams.set(k,u.searchParams.get(k));return [{url:clean.href,text:text(a)}];}catch{return [];}});
 const navLinks=[...document.querySelectorAll('nav,[role="navigation"],[role="banner"]')].filter(visible).flatMap(e=>links(e)),boxes=[...document.querySelectorAll('[role="textbox"][contenteditable="true"]')].filter(visible);
 const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible),editor=dialogs.find(d=>d.querySelector('[role="textbox"][contenteditable="true"]'));
 const groupId=new URL(location.href).pathname.match(/^\/groups\/([1-9]\d*)/)?.[1];
 const profileLink=link=>{try{const u=new URL(link.url);return u.protocol==='https:'&&['www.facebook.com','facebook.com'].includes(u.hostname)&&(/^\/[1-9]\d*\/?$/.test(u.pathname)||u.pathname==='/profile.php'&&/^[1-9]\d*$/.test(u.searchParams.get('id')||'')||groupId&&new RegExp('^/groups/'+groupId+'/user/[1-9]\\d*/?$').test(u.pathname));}catch{return false;}};
 const rows=[...document.querySelectorAll('[role="article"]')].filter(visible).flatMap(e=>{const messages=[...e.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"]')].filter(m=>visible(m)&&m.closest('[role="article"]')===e);const ownLinks=links(e),photos=new Set([...e.querySelectorAll('a[href]')].filter(a=>visible(a)&&a.closest('[role="article"]')===e&&[...a.querySelectorAll('img')].some(img=>visible(img)&&img.complete&&img.naturalWidth>0)).flatMap(a=>{try{const u=new URL(a.href);return ['www.facebook.com','facebook.com'].includes(u.hostname)&&/^\/photo(?:\.php|\/)\/?$/.test(u.pathname)&&/^[1-9]\d*$/.test(u.searchParams.get('fbid')||'')?[u.searchParams.get('fbid')]:[];}catch{return [];}}));
  if(messages.length!==1)return [];const parentArticle=e.parentElement?.closest('[role="article"]');if(parentArticle&&[...parentArticle.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"]')].some(m=>m.closest('[role="article"]')===parentArticle))return [];
  // Only a main-article heading BEFORE its message can establish the author.
  // Body mentions, quote headings, nested article/comment authors never enter it.
  const headings=[...e.querySelectorAll('h2,h3,h4,[role="heading"]')].filter(h=>visible(h)&&h.closest('[role="article"]')===e&&!h.closest('blockquote,[data-ad-preview="message"],[data-ad-comet-preview="message"]')&&!h.parentElement?.closest('h2,h3,h4,[role="heading"]')&&(h.compareDocumentPosition(messages[0])&4));
  const authorRegions=headings.map(h=>links(h,e).filter(a=>profileLink(a))).filter(a=>a.length),author={source:'MAIN_POST_AUTHOR_HEADING',regionCount:authorRegions.length,links:authorRegions.flat()};
  return [{body:text(messages[0]),author,links:ownLinks,mediaCount:photos.size,times:[...e.querySelectorAll('time,abbr,[data-utime]')].filter(t=>{if(!visible(t)||t.closest('[role="article"]')!==e)return false;const a=t.closest('a[href]');if(!a)return false;try{const u=new URL(a.href);return /\/posts\/|\/permalink\//.test(u.pathname)&&!u.searchParams.has('comment_id')&&!u.searchParams.has('reply_comment_id');}catch{return false;}}).flatMap(t=>[t.getAttribute('datetime'),t.getAttribute('data-utime'),t.getAttribute('title'),text(t)]).filter(Boolean)}];});
 // Avatar images never establish an attachment. Unknown preview markup blocks.
 const removals=editor?[...editor.querySelectorAll('[role="button"],button')].filter(e=>visible(e)&&/^Remove photo$/i.test(e.getAttribute('aria-label')||text(e))):[];
 const buttons=[...document.querySelectorAll('[role="button"],button')].filter(visible),joined=buttons.filter(e=>/^Joined$/i.test(e.getAttribute('aria-label')||text(e)));
 const publishNow=dialogs.some(d=>[...d.querySelectorAll('[role="radio"][aria-checked="true"],input[type="radio"]:checked')].filter(visible).some(e=>/^Publish now$|^Post now$/i.test(e.getAttribute('aria-label')||text(e))));
 const previews=editor?[...editor.querySelectorAll('img')].filter(img=>{const r=img.getBoundingClientRect();return visible(img)&&img.complete&&img.naturalWidth>0&&r.width>=64&&r.height>=64;}).flatMap(img=>{try{const u=new URL(img.currentSrc||img.src);if(!['https:','blob:'].includes(u.protocol))return [];return [{source:u.protocol==='blob:'?'blob:'+u.pathname:u.origin+u.pathname,width:img.naturalWidth,height:img.naturalHeight}];}catch{return [];}}):[];
 const audience=editor&&[...editor.querySelectorAll('[role="button"],button')].filter(visible).some(e=>/^Sharing with Public$|^Public$/i.test(e.getAttribute('aria-label')||text(e)))?'PUBLIC':'UNKNOWN';
 return {url:location.href,visibleText:text(document.body).slice(0,20000),navLinks,membership:joined.length===1?'JOINED':'UNKNOWN',publishNow,editor:editor?{text:text(editor),body:boxes.length===1?text(boxes[0]):null,boxCount:boxes.length,boxLabel:boxes.length===1?boxes[0].getAttribute('aria-label'):null,audience,mediaCount:removals.length,mediaPreviews:previews}:null,rows};
}
/** Uses existing atomic claims, history, leases and deadline guards. No retries. */
export class BrowserSkillPublicationDriver{
 constructor(snapshot,adapter,{assertScope,proveHistory}={}){
  if(!adapter||typeof assertScope!=='function'||typeof proveHistory!=='function')fail('BSK_PUBLICATION_GUARDS_REQUIRED');
  if(snapshot?.platform!=='facebook'||snapshot.transport!=='BROWSER_SKILL'||!['FACEBOOK_PAGE_PUBLISH','FACEBOOK_GROUP_PUBLISH'].includes(snapshot.operation)||snapshot.profileDir!==null||snapshot.cdpPort!==null||snapshot.credentialRef!==null||!snapshot.body?.trim())fail('BSK_FRESH_PUBLICATION_SNAPSHOT_REQUIRED');
  const current=adapter.current(),b=adapter.binding,r=snapshot.executionRef;
  if(r?.kind!=='BROWSER_SKILL'||r.instanceId!==b.browser_instance_id||r.bindingHash!==current.fingerprint||snapshot.profileId!==current.profileId||snapshot.workspace!==b.workspace||snapshot.accountId!==b.account_id||snapshot.operatorActorId!==b.actor_id||snapshot.externalId!==b.actor_id||snapshot.targetPageId!==b.target_page_id)fail('BSK_PUBLICATION_BINDING_MISMATCH');
  this.snapshot=structuredClone(snapshot);this.adapter=adapter;this.client=adapter.client;this.assertScope=assertScope;this.proveHistory=proveHistory;this.session=null;this.tab=null;this.prepared=false;this.dispatched=false;this.stage='NEW';
 }
 async document(tab=this.tab){const doc=await this.client.read(this.session,tab,readPublicationDocument,{});const url=new URL(doc.url);if(url.protocol!=='https:'||!['www.facebook.com','facebook.com'].includes(url.hostname)||/checkpoint|login challenge|temporarily blocked|security check|suspicious activity|restricted/i.test(doc.url+' '+doc.visibleText))fail('BSK_PUBLICATION_PLATFORM_STOP');if(this.snapshot.groupUrl&&(url.pathname.split('/').slice(0,3).join('/')!==new URL(this.snapshot.groupUrl).pathname.replace(/\/$/,'')||doc.membership!=='JOINED'))fail('BSK_PUBLICATION_GROUP_TARGET_CHANGED');observedIdentity(doc,this.adapter.binding);return doc;}
 async ref(role,label){const v=await this.client.observe(this.session,this.tab),pattern=new RegExp('@e(\\d+) '+role+' "'+escape(label)+'(?: \\[has-submenu\\])?"','g'),matches=[...v.text.matchAll(pattern)];if(matches.length!==1)fail('BSK_PUBLICATION_UNIQUE_CONTROL_REQUIRED');return '@e'+matches[0][1];}
 async click(role,label){const ref=await this.ref(role,label);await this.client.refInput(this.session,this.tab,'click',ref);}
 guard(){this.assertScope();const current=this.adapter.current();if(current.fingerprint!==this.snapshot.executionRef.bindingHash)fail('BSK_PUBLICATION_BINDING_CHANGED');}
 assertEditorScope(doc){
  observedIdentity(doc,this.adapter.binding);const e=doc.editor,s=this.snapshot,u=new URL(doc.url);
  if(e?.boxCount!==1||norm(e.boxLabel)!==norm("What's on your mind, "+s.expectedIdentity+'?'))fail('BSK_PUBLICATION_EDITOR_SCOPE_REQUIRED');
  if(!s.groupUrl&&(e.audience!=='PUBLIC'||!['/'+s.operatorActorId,'/'+s.operatorActorId+'/','/professional_dashboard/content/content_library/'].includes(u.pathname)))fail('BSK_PUBLICATION_DESTINATION_CHANGED');
 }
 assertForm(doc,{publishNow=false,originalPreview=true}={}){
  this.assertEditorScope(doc);const e=doc.editor;
  if(norm(e.body)!==norm(this.snapshot.body)||e.mediaCount!==this.snapshot.assetMetadata.length||!Array.isArray(e.mediaPreviews)||e.mediaPreviews.length!==e.mediaCount)fail('BSK_PUBLICATION_FORM_CHANGED');
  if(originalPreview&&hash(JSON.stringify(e.mediaPreviews))!==this.preparedPreviewHash)fail('BSK_PUBLICATION_PREVIEW_CHANGED');
  if(publishNow&&doc.publishNow!==true)fail('BSK_PUBLICATION_NOW_DESTINATION_REQUIRED');
 }
 async prepare(snapshot,assets,onWrite){
  if(this.stage!=='NEW'||JSON.stringify(snapshot)!==JSON.stringify(this.snapshot)||typeof onWrite!=='function')fail('BSK_ONE_PREPARATION_REQUIRED');
  if(!Array.isArray(assets)||assets.length!==1||!/\.(png|jpe?g|webp)$/i.test(assets[0])||!Array.isArray(snapshot.assetMetadata)||snapshot.assetMetadata.length!==1)fail('BSK_REVIEWED_SINGLE_IMAGE_REQUIRED');
  const bytes=readFileSync(assets[0]),meta=snapshot.assetMetadata[0];if(meta.ordinal!==0||meta.size!==bytes.length||meta.sha256!==hash(bytes))fail('BSK_FROZEN_MEDIA_CHANGED');
  this.guard();if(await this.proveHistory(snapshot)!==true)fail('BSK_COMPLETE_PUBLICATION_HISTORY_REQUIRED');
  const group=snapshot.operation==='FACEBOOK_GROUP_PUBLISH';let url='https://www.facebook.com/professional_dashboard/content/content_library/';
  if(group){const g=new URL(snapshot.groupUrl);if(g.protocol!=='https:'||g.hostname!=='www.facebook.com'||!/^\/groups\/[1-9]\d*\/?$/.test(g.pathname)||g.search||g.hash)fail('BSK_FROZEN_GROUP_REQUIRED');url=g.href;}
  this.stage='PREPARING';this.session=await this.client.start(this.adapter.binding.browser_instance_id);
  this.tab=await this.client.tab(this.session,url);await this.client.activate(this.session,this.tab);let doc=await this.document();if(doc.editor)fail('BSK_EXISTING_COMPOSER_NOT_REUSED');if(doc.rows.some(r=>norm(r.body)===norm(snapshot.body)))fail('BSK_PLATFORM_DUPLICATE_OBSERVED');
  this.guard();await onWrite();if(group)await this.click('button','Write something...');else{await this.click('button','Create a post');await this.click('menuitem','Post');}
  doc=await this.document();this.assertEditorScope(doc);
  if(norm(doc.editor.body)!==norm(snapshot.body)){
   if(norm(doc.editor.body))fail('BSK_DIFFERENT_DRAFT_NOT_OVERWRITTEN');
   this.guard();const ref=await this.ref('textbox',"What's on your mind, "+snapshot.expectedIdentity+'?');
   // Empty Lexical editors can replace their node during Ctrl+A/Backspace.
   // Use supported no-clear only after proving empty; never erase a user draft.
   await this.client.refInput(this.session,this.tab,'fill',ref,snapshot.body,{noClear:true});
  }
  doc=await this.document();if(norm(doc.editor?.body)!==norm(snapshot.body))fail('BSK_PUBLICATION_FULL_BODY_MISMATCH');
  this.guard();const upload=await this.ref('button','Photo/video');await this.client.upload(this.session,this.tab,upload,assets[0]);
  doc=await this.document();this.assertForm(doc,{originalPreview:false});this.preparedPreviewHash=hash(JSON.stringify(doc.editor.mediaPreviews));
  this.prepared=true;this.stage='PREPARED';return {operation:snapshot.operation,transport:'BROWSER_SKILL',instanceId:this.adapter.binding.browser_instance_id,mediaCount:1};
 }
 async submit(onDispatch=()=>{}){
  if(!this.prepared||this.submitAttempted)fail('BSK_PUBLICATION_ONE_SUBMIT_REQUIRED');this.submitAttempted=true;this.guard();this.assertForm(await this.document());
  const page=!this.snapshot.groupUrl;if(page){await this.click('button','Next');this.assertForm(await this.document(),{publishNow:true});}
  const ref=await this.ref('button','Post');this.guard();await onDispatch();this.guard();
  this.assertForm(await this.document(),{publishNow:page});this.guard();this.dispatchedAt=Date.now();this.dispatched=true;this.stage='SUBMITTING';await this.client.refInput(this.session,this.tab,'click',ref);return null;
 }
 async readback(snapshot){
  if(!this.dispatched||JSON.stringify(snapshot)!==JSON.stringify(this.snapshot))fail('BSK_PUBLICATION_DISPATCH_REQUIRED');
  const url=snapshot.groupUrl||'https://www.facebook.com/'+snapshot.operatorActorId,tab=await this.client.tab(this.session,url);const doc=await this.document(tab);
  if(/post is pending|pending approval|awaiting approval/i.test(doc.visibleText))fail('BSK_PENDING_PUBLICATION_NOT_CONFIRMED');
  const freshTime=r=>[...new Set(r.times?.map(publicationEpoch).filter(ms=>Number.isFinite(ms)&&ms>=Math.floor(this.dispatchedAt/1000)*1000&&ms<=Date.now()+1000).map(ms=>Math.floor(ms/1000)*1000))];
  const rows=doc.rows.filter(r=>norm(r.body)===norm(snapshot.body)&&r.mediaCount===snapshot.assetMetadata.length&&Array.isArray(r.times)&&freshTime(r).length===1),matches=[];
  for(const row of rows){const author=snapshot.groupUrl?publicationAuthor(row,snapshot.groupUrl):null;for(const link of row.links){const u=new URL(link.url);if(u.protocol!=='https:'||!['www.facebook.com','facebook.com'].includes(u.hostname))continue;const page=u.pathname.match(/^\/([1-9]\d*)\/posts\/([^/]+)\/?$/),group=u.pathname.match(/^\/groups\/([1-9]\d*)\/(?:posts|permalink)\/([^/]+)\/?$/);if(snapshot.groupUrl?author?.id===snapshot.operatorActorId&&group&&new URL(snapshot.groupUrl).pathname.split('/')[2]===group[1]:page&&page[1]===snapshot.operatorActorId)matches.push({id:group?.[2]||page[2],url:u.origin+u.pathname,observedTimes:row.times.filter(observedPublicationTime),...(author?{authorId:author.id,authorUrl:author.url,authorEvidence:author.source}:{})});}}
  const unique=[...new Map(matches.map(m=>[m.url,m])).values()];if(unique.length!==1)fail('BSK_PUBLICATION_CANONICAL_READBACK_NOT_PROVEN');this.stage='CONFIRMED';return {verified:true,bodyUrlVerified:true,mediaVerified:true,mediaCount:snapshot.assetMetadata.length,originalMediaHashes:snapshot.assetMetadata,...unique[0],operatorActorId:snapshot.operatorActorId,targetPageId:snapshot.targetPageId,contentHash:snapshot.contentHash,payloadHash:snapshot.payloadHash,dispatchedAt:new Date(this.dispatchedAt).toISOString(),checkedAt:new Date().toISOString(),identityEvidence:'BSK_VISIBLE_ACTOR_BUSINESS_ASSET',method:'BSK_FRESH_OWNED_TIMELINE_READBACK'};
 }
 failureEvidence(){return {stage:this.stage,submitted:this.dispatched,finalClickAttempted:this.dispatched,retryAllowed:false,origin:'TASK_ACTION_BSK_PUBLICATION'};}
 async close(){if(this.session)await this.client.stop(this.session);this.session=null;}
}
