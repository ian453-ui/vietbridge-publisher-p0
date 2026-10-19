import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
const functionLine=name=>source.split('\n').find(line=>line.startsWith(`function ${name}(`)||line.startsWith(`async function ${name}(`));
const updateFunction=source.slice(source.indexOf('async function checkGptUpdates('),source.indexOf('\nsetInterval(',source.indexOf('async function checkGptUpdates(')));
function updateContext(get){
 const context=vm.createContext({librarySummary:false,catalogueReadError:'',workspace:'ws-test',loadEpoch:0,loadedWorkspace:'ws-test',route:'groups',gptUpdateBusy:false,gptUpdateWorkspace:'',gptUpdateCheckedAt:'',gptUpdateError:'',libraryItems:[{key:'old'}],libraryWorkspace:'ws-test',libraryPicked:new Set(['old']),pendingLibraryScopes:new Set(),libraryScope:()=> 'ws-test:account-test',selectedContents:new Set(),message:'',get,render(){},encodeURIComponent,Date,Set});
 vm.runInContext(updateFunction,context);return context;
}

test('manual and automatic update use forced refresh, retain state on error and recover on retry',async()=>{
 let fail=true;const urls=[];
 const context=updateContext(async url=>{urls.push(url);if(fail)throw Error('Sync unavailable');return {items:[{key:'new',revision:'v2',ready:false}]};});
 await vm.runInContext('checkGptUpdates()',context);
 assert.equal(context.libraryItems[0].key,'old');assert.equal(context.gptUpdateCheckedAt,'');assert.match(context.gptUpdateError,/Sync unavailable/);
 fail=false;await vm.runInContext('checkGptUpdates(true)',context);
 assert.equal(context.libraryItems[0].revision,'v2');assert.equal(context.gptUpdateError,'');assert.ok(context.gptUpdateCheckedAt);
 assert.equal(context.libraryPicked.size,0);assert.ok(urls.every(url=>url.includes('refresh=1')));
});
test('overlapping checks coalesce and a prior workspace response cannot replace current drafts',async()=>{
 let finish,calls=0;
 const context=updateContext(()=>{calls++;return new Promise(resolve=>{finish=resolve});});
 const first=vm.runInContext('checkGptUpdates()',context);
 await vm.runInContext('checkGptUpdates(true)',context);assert.equal(calls,1);
 context.workspace='ws-other';finish({items:[{key:'wrong-workspace'}]});await first;
 assert.equal(context.libraryItems[0].key,'old');assert.equal(context.gptUpdateBusy,false);
});

test('review source remains visible before Facebook account setup',()=>{
 const html=vm.runInNewContext(functionLine('groups')+'\ngroups()',{
  selectedFacebookAccount:()=>null,
  contentSourceView:()=>'<section class="review-source">Pending submission</section>'
 });
 assert.match(html,/review-source/);
 assert.match(html,/发布到群组前/);
});

test('unavailable library preserves page and permits refresh retry',async()=>{
 let rendered=0,requests=0;
 const state={workspace:'ws-test',workspaces:[{id:'ws-test'}]};
 const context=vm.createContext({
  clearTimeout,librarySearchTimer:null,librarySearchController:null,catalogueReadError:'',core:null,fb:null,workspace:'ws-test',route:'groups',libraryWorkspace:'',
  libraryItems:[{articleId:'OLD'}],libraryPicked:new Set(['OLD']),
  message:'',loadEpoch:0,loadController:null,loadedWorkspace:'ws-test',AbortController,encodeURIComponent,showWorkspaceLoading(){throw Error('Existing customer page must remain available on library failure');},
  get:async url=>{if(url.startsWith('/api/state'))return state;if(url.startsWith('/api/facebook'))return {};requests++;throw Error('Not connected');},
  render:()=>rendered++,document:{querySelector:()=>{throw Error('Full page replaced');}},
  localStorage:{removeItem(){}},esc:String
 });
 vm.runInContext(source.slice(source.indexOf('async function load({'),source.indexOf('async function post(')),context);
 await vm.runInContext('load()',context);
 assert.equal(rendered,1);assert.equal(context.libraryItems.length,0);
 assert.match(context.message,/资料库暂不可用/);
 assert.equal(context.libraryWorkspace,'');
 await vm.runInContext('load()',context);assert.equal(requests,2);
});

test('publisher as well as groups refreshes the local catalogue; hidden pages do not poll',()=>{
 const line=source.split('\n').find(x=>x.startsWith('setInterval(()=>{if(')&&x.includes('checkGptUpdates()'));
 let tick,calls=0;const context=vm.createContext({route:'v1',workspace:'ws-test',loadedWorkspace:'ws-test',document:{visibilityState:'visible'},checkGptUpdates(){calls++;},setInterval(fn){tick=fn;}});
 vm.runInContext(line,context);tick();assert.equal(calls,1);context.route='groups';tick();assert.equal(calls,2);context.document.visibilityState='hidden';tick();assert.equal(calls,2);context.document.visibilityState='visible';context.route='settings';tick();assert.equal(calls,2);
});

test('a changed library revision loses pending checks rather than silently approving the replacement',async()=>{
 const context=updateContext(async()=>({items:[{key:'old',revision:'new',ready:true}]}));context.libraryItems=[{key:'old',revision:'previous',ready:true}];await vm.runInContext('checkGptUpdates()',context);assert.equal(context.libraryItems[0].revision,'new');assert.equal(context.libraryPicked.size,0);assert.equal(context.pendingLibraryScopes.has('ws-test:account-test'),true);assert.equal(context.selectedContents.size,0);
});

test('refreshing residual imported checks preserves the frozen selection',async()=>{
 const context=updateContext(async()=>({items:[{key:'old',revision:'new',ready:true}]}));context.libraryItems=[{key:'old',revision:'previous',ready:true}];context.selectedContents=new Set(['frozen-content']);await vm.runInContext('checkGptUpdates()',context);assert.equal(context.libraryPicked.size,0);assert.equal(context.pendingLibraryScopes.size,0);assert.equal(context.selectedContents.has('frozen-content'),true);
});

test('existing inbox review shows both versions and enables only the same-ID revision approval',()=>{
 const start=source.indexOf('function gptReviewArticle('),end=source.indexOf('function showGptInbox(',start),code=source.slice(start,end),previous={contentRevision:1,visualRevision:7,title:'Old title',body:'Old full caption',imageHash:'a'.repeat(64)},base={articleId:'MOCK-REVISION-011',key:'old-key',revision:'old-rev',contentRevision:1,visualRevision:7,body:previous.body,assets:[{role:'cover',revision:previous.imageHash}]},item={articleId:base.articleId,key:'new-key',revision:'new-rev',revisionNumber:2,visualRevision:8,title:'New title',body:'New full caption <unsafe>',assets:[{role:'cover'}],reviewStatus:'UPDATE_AVAILABLE',previousVersion:previous,blockingReason:'Review both versions'};
 const context={workspace:'ws-test',libraryItems:[item,base],encodeURIComponent,esc:value=>String(value).replaceAll('<','&lt;')};
 const html=vm.runInNewContext(code+'\ngptReviewArticle(item)',{...context,item});assert.match(html,/旧版 · 正文 1 \/ 图片 7/);assert.match(html,/正文版本 2 · 图片版本 8/);assert.match(html,/Old full caption/);assert.match(html,/New full caption &lt;unsafe>/);assert.equal((html.match(/<img /g)||[]).length,2);assert.match(html,/key=old-key/);assert.match(html,/key=new-key/);assert.match(html,/确认新版并加入发布资料库/);assert.doesNotMatch(html,/data-reject-gpt/);
 const conflict=vm.runInNewContext(code+'\ngptReviewArticle(item)',{...context,item:{...item,reviewStatus:'VERSION_CONFLICT'}});assert.doesNotMatch(conflict,/data-approve-gpt/);
});

test('same-ID UI approval carries the viewed old base and cannot replace another workspace after navigation',async()=>{
 const start=source.indexOf('function gptReviewArticle('),end=source.indexOf('\nfunction ',source.indexOf('function showGptInbox(',start)+1),code=source.slice(start,end),item={articleId:'MOCK-REVISION-011',key:'k'.repeat(64),revision:'r'.repeat(64),revisionNumber:2,visualRevision:8,title:'New fixture',body:'Next body',assets:[],reviewStatus:'UPDATE_AVAILABLE',previousRevision:'p'.repeat(64),previousVersion:{contentRevision:1,visualRevision:7,title:'Old',body:'Old body',imageHash:'a'.repeat(64)}};
 const approve={},check={},section={innerHTML:'',querySelector:()=>check,querySelectorAll:selector=>selector==='[data-approve-gpt]'?[approve]:[]};approve.dataset={approveGpt:item.key};const calls=[];const context=vm.createContext({workspace:'ws-one',libraryWorkspace:'ws-one',libraryItems:[item],gptUpdateBusy:false,gptUpdateWorkspace:'',gptUpdateCheckedAt:'',gptUpdateError:'',encodeURIComponent,esc:String,message:'',render(){throw Error('Must not render old response into new workspace');},checkGptUpdates(){},window:{confirm:()=>true},document:{querySelector:()=>({closest:()=>({before(){}})}),createElement:()=>section},request:async(path,body)=>{calls.push({path,body});context.workspace='ws-two';},get:async path=>{calls.push({path});return {items:[{articleId:'wrong-response'}]};}});
 vm.runInContext(code+'\nshowGptInbox()',context);await approve.onclick();assert.equal(calls[0].path,'/api/workspaces/ws-one/library/approve-gpt');assert.equal(calls[0].body.previous_revision,item.previousRevision);assert.match(calls[1].path,/workspace=ws-one/);assert.equal(context.libraryWorkspace,'ws-one');assert.equal(context.libraryItems[0].articleId,item.articleId);
});

test('A to another customer and back rejects the old catalogue response by generation',async()=>{
 let release;const ctx=updateContext(()=>new Promise(r=>release=r));const pending=vm.runInContext('checkGptUpdates()',ctx);ctx.workspace='other';ctx.loadEpoch++;ctx.workspace='ws-test';ctx.loadEpoch++;release({items:[{key:'stale',revision:'old'}]});await pending;assert.equal(ctx.libraryItems[0].key,'old');assert.equal(ctx.gptUpdateBusy,false);
});
