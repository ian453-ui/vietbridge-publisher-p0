import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/scoped-fixture.js';
import {wirePublication} from './helpers/browser-skill-publication-fixture.js';
import * as publication from '../src/browser-skill-publication.js';
import {observedIdentity} from '../src/browser-skill-facebook.js';

function target(f,kind){const page=f.makePage('Reviewed full image body',true);if(kind==='PAGE')return page;const g=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Explicit joined',url:'https://www.facebook.com/groups/12345/'});return f.store.createGroupJobs(f.w.id,{account_id:f.account.id,content_id:page.content_id,group_ids:[g.id]})[0];}
async function run(f,kind,j,cap){const input={confirm:true,scope_hash:cap.scopeHash,...(kind==='GROUP'?{ack_group_rules:true}:{})};return kind==='PAGE'?f.executor.execute(f.w.id,j.id,input):f.scoped.executeGroup(f.w.id,j.id,input);}
function mutate(doc,change){if(change.missingEditor){doc.editor=null;return;}if(change.navActor){doc.navLinks[0]={url:'https://www.facebook.com/999/ad_center/'};return;}if(change.url){doc.url=change.url;return;}if(change.publishNow!==undefined){doc.publishNow=change.publishNow;return;}doc.editor={...doc.editor,...change};}
async function changedForm(t,kind,phase,change){
 const f=setup(t),{client}=wirePublication(f);let next=false,uploaded=false,finalObserved=false,changedReads=0;const read=client.read,observe=client.observe,input=client.refInput,upload=client.upload;
 client.refInput=async(...args)=>{const out=await input(...args);if(args[3]==='@e6')next=true;return out;};client.upload=async(...args)=>{const out=await upload(...args);uploaded=true;return out;};
 client.observe=async(...args)=>{const out=await observe(...args);if(kind==='PAGE'?next:uploaded)finalObserved=true;return out;};
 client.read=async(...args)=>{const doc=await read(...args);if(phase==='next'?next:finalObserved){mutate(doc,change);changedReads++;}return doc;};
 const j=target(f,kind),cap=f.scoped.capability(kind,j.id);assert.equal(cap.canExecute,true,cap.reason);await assert.rejects(run(f,kind,j,cap));assert.ok(changedReads>0);assert.equal(client.submits,0);assert.equal(client.calls.filter(c=>c[0]==='fill').length,1);assert.equal(client.calls.filter(c=>c[0]==='upload').length,1);assert.equal(f.scoped.permits.read(kind+':'+j.id).status,'CONSUMED');
 assert.equal(kind==='PAGE'?f.publisher.job(f.w.id,j.id).state:f.store.job(f.w.id,j.id).state,'UNKNOWN');await assert.rejects(run(f,kind,j,cap));assert.equal(client.submits,0);
}
for(const change of [{body:'Foreign changed draft',mediaCount:0},{mediaCount:0},{mediaCount:2}])test('P1 Page Next changed form stops without final Post '+JSON.stringify(change),t=>changedForm(t,'PAGE','next',change));
for(const kind of ['PAGE','GROUP'])for(const change of [{body:'Foreign changed draft'},{mediaCount:0},{mediaPreviews:[{source:'blob:https://www.facebook.com/replaced',width:128,height:128}]},{missingEditor:true}])test('P1 '+kind+' final observation must validate full form '+JSON.stringify(change),t=>changedForm(t,kind,'final',change));
for(const change of [{boxLabel:"What's on your mind, Foreign Page?"},{audience:'PRIVATE'},{publishNow:false},{navActor:true},{url:'https://www.facebook.com/groups/999/'}])test('P1 Page final identity/destination/control information cannot change '+JSON.stringify(change),t=>changedForm(t,'PAGE','final',change));

for(const mode of ['foreign-body-mention','missing-author','duplicate-regions','duplicate-links','body-source'])test('P1 Group '+mode+' cannot use body links as author proof',async t=>{
 const f=setup(t),{client,binding}=wirePublication(f,{wrongAuthor:mode==='foreign-body-mention'}),read=client.read;
 client.read=async(...args)=>{const doc=await read(...args);for(const row of doc.rows){row.links.push({url:'https://www.facebook.com/'+binding.actor_id});if(mode==='missing-author')delete row.author;if(mode==='duplicate-regions')row.author.regionCount=2;if(mode==='duplicate-links')row.author.links.push({...row.author.links[0]});if(mode==='body-source')row.author.source='BODY_MENTION';}return doc;};
 const j=target(f,'GROUP'),cap=f.scoped.capability('GROUP',j.id);await assert.rejects(run(f,'GROUP',j,cap),/READBACK_NOT_PROVEN/);assert.equal(client.submits,1);assert.equal(f.store.job(f.w.id,j.id).state,'UNKNOWN');assert.equal(f.store.db.prepare('SELECT count(*) n FROM published_posts').get().n,0);assert.equal(f.scoped.permits.read('GROUP:'+j.id).status,'CONSUMED');await assert.rejects(run(f,'GROUP',j,cap));assert.equal(client.submits,1);
});
test('explicit unique header author supports only numeric Page/profile or matching Group-user URLs',()=>{
 const row=url=>({author:{source:'MAIN_POST_AUTHOR_HEADING',regionCount:1,links:[{url}]}}),group='https://www.facebook.com/groups/12345/';
 for(const url of ['https://www.facebook.com/123/','https://www.facebook.com/profile.php?id=123','https://www.facebook.com/groups/12345/user/123/'])assert.equal(publication.publicationAuthor(row(url),group).id,'123');
 for(const url of ['https://www.facebook.com/groups/999/user/123/','https://evil.example/123','https://www.facebook.com/vanity-name','http://www.facebook.com/123','https://www.facebook.com/123?story_fbid=9'])assert.equal(publication.publicationAuthor(row(url),group),null);
});

// A small semantic DOM mock; no browser/parser/network dependency. It models
// tree ancestry/order so tests exercise heading vs message/quote/comment origin.
class Element{
 constructor(tag,attrs={},text='',children=[]){this.tagName=tag.toUpperCase();this.attrs=attrs;this.ownText=text;this.children=[];this.complete=true;this.naturalWidth=128;this.naturalHeight=128;this.src=attrs.src||'';this.currentSrc=this.src;this.href=attrs.href;for(const child of children)this.add(child);}
 add(child){child.parentElement=this;this.children.push(child);return this;}
 getAttribute(k){return this.attrs[k]??null;}
 get innerText(){return [this.ownText,...this.children.map(c=>c.innerText)].filter(Boolean).join('\n');}
 get textContent(){return this.innerText;}
 getClientRects(){return [{width:128,height:128}];}
 getBoundingClientRect(){return {width:128,height:128};}
 matches(selector){return selector.split(',').some(s=>{s=s.trim();const tag=s.match(/^[a-z0-9]+/i)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;for(const m of s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g))if(m[2]===undefined?!Object.hasOwn(this.attrs,m[1]):this.attrs[m[1]]!==m[2])return false;return !s.includes(':checked')||this.attrs.checked==='true';});}
 querySelectorAll(selector){const out=[];for(const child of this.children){if(child.matches(selector))out.push(child);out.push(...child.querySelectorAll(selector));}return out;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches(selector))return n;return null;}
 compareDocumentPosition(other){let root=this;while(root.parentElement)root=root.parentElement;const order=[];const visit=n=>{order.push(n);n.children.forEach(visit);};visit(root);return order.indexOf(other)>order.indexOf(this)?4:2;}
}
const link=(id,text='Author')=>new Element('a',{href:'https://www.facebook.com/'+id},text);
const message=children=>new Element('div',{'data-ad-preview':'message'},'Reviewed DOM body',children);
function docFrom(t,article){const root=new Element('body',{},'', [article]),prior=new Map(['document','location','getComputedStyle'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));Object.defineProperties(globalThis,{document:{value:{body:root,querySelectorAll:s=>root.querySelectorAll(s)},configurable:true},location:{value:{href:'https://www.facebook.com/groups/12345/'},configurable:true},getComputedStyle:{value:()=>({visibility:'visible'}),configurable:true}});t.after(()=>{for(const [k,d] of prior)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});return publication.readPublicationDocument();}
test('DOM author proof comes from foreign header, never the expected Actor mention in message',t=>{
 const row=new Element('div',{role:'article'},'', [new Element('h3',{},'', [link('999')]),message([link('123','Expected Actor mention')])]),doc=docFrom(t,row);assert.equal(doc.rows.length,1);assert.equal(publication.publicationAuthor(doc.rows[0],doc.url).id,'999');assert.ok(doc.rows[0].links.some(l=>l.url==='https://www.facebook.com/123'));
});
test('DOM nested comment/quote authors cannot establish a missing main-post author',t=>{
 const comment=new Element('div',{role:'article'},'', [new Element('h3',{},'', [link('123')]),message([])]),quote=new Element('blockquote',{},'', [new Element('h3',{},'', [link('123')])]),row=new Element('div',{role:'article'},'', [quote,message([link('123')]),comment]),doc=docFrom(t,row);assert.equal(doc.rows.length,1);assert.equal(doc.rows[0].author.regionCount,0);assert.equal(publication.publicationAuthor(doc.rows[0],doc.url),null);
});
test('DOM two main author headings are ambiguous even when both link the same Actor',t=>{
 const row=new Element('div',{role:'article'},'', [new Element('h3',{},'', [link('123')]),new Element('h3',{},'', [link('123')]),message([])]),doc=docFrom(t,row);assert.equal(doc.rows[0].author.regionCount,2);assert.equal(publication.publicationAuthor(doc.rows[0],doc.url),null);
});
function navigationDocument(t,{leadingBanner=false,actor='123',page='456'}={}){
 const actorNav=new Element('nav',{},'', [new Element('a',{href:'https://www.facebook.com/'+actor+'/ad_center/'},'Ad center')]),pageNav=new Element('div',{role:'navigation'},'', [new Element('a',{href:'https://business.facebook.com/latest/inbox/all/?asset_id='+page},'Inbox')]);
 const regions=leadingBanner?[new Element('div',{role:'banner'},'', [link('777')]),actorNav,pageNav]:[actorNav,pageNav];return docFrom(t,new Element('section',{},'',regions));
}
for(const leadingBanner of [false,true])test('P2 navigation identity survives two or three separate visible regions '+leadingBanner,t=>{
 const doc=navigationDocument(t,{leadingBanner});assert.equal(doc.navLinks.length,leadingBanner?3:2);assert.deepEqual(observedIdentity(doc,{actor_id:'123',target_page_id:'456'}),{actorId:'123',targetPageId:'456'});
});
for(const wrong of [{actor:'999'},{page:'999'}])test('P2 navigation keeps wrong Actor or Page rejected across multiple regions '+JSON.stringify(wrong),t=>{
 const doc=navigationDocument(t,{leadingBanner:true,...wrong});assert.throws(()=>observedIdentity(doc,{actor_id:'123',target_page_id:'456'}),/BSK_VISIBLE_ACTOR_AND_PAGE_NOT_VERIFIED/);
});
