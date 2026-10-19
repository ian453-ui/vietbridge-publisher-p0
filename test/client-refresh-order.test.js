import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
const load=source.slice(source.indexOf('async function load({'),source.indexOf('async function post('));
function harness(get){
 const renders=[],loading=[];
 const h=new Function('get','record','loading','AbortController',`let loadEpoch=0,loadController=null,loadedWorkspace='A',core={workspaces:[{id:'A'},{id:'B'}]},fb,workspace='A',route='settings',libraryWorkspace='A',libraryItems=[],libraryPicked=new Set(),message='',catalogueReadError='',librarySummary=false,libraryPage=0,libraryQuery='',libraryMatches=null,librarySearchTimer=null,librarySearchController=null,libraryDetails=new Map(),verification,wechatInventory,wechatBrowserStatus;const render=()=>record({workspace,identity:fb?.identity});const showWorkspaceLoading=error=>loading.push({workspace,error});${load};return {load,choose:ws=>{workspace=ws;loadedWorkspace=null;fb=null;return load({reset:true});},snapshot:()=>({workspace,loadedWorkspace,core,fb})};`)(get,v=>renders.push(v),loading,AbortController);
 return {...h,renders,loading};
}
const state={workspaces:[{id:'A'},{id:'B'}]};
test('late A response is discarded: B customer, account, content and jobs commit together',async()=>{
 let release,start;const gate=new Promise(r=>release=r),started=new Promise(r=>start=r),signals=[];
 const h=harness(async(path,options)=>{signals.push(options.signal);if(path.startsWith('/api/state'))return state;const ws=new URL(path,'http://fixture').searchParams.get('workspace');if(ws==='A'){start();await gate;}return {identity:ws,accounts:[{workspace:ws,id:ws+'-account'}],groupContent:[{workspace:ws,id:ws+'-content'}],groupJobs:[{workspace:ws,id:ws+'-job'}]};});
 const old=h.load();await started;await h.choose('B');assert.equal(signals[0].aborted,true);assert.equal(h.snapshot().fb.identity,'B');release();await old;
 assert.deepEqual(h.renders,[{workspace:'B',identity:'B'}]);assert.equal(h.snapshot().fb.accounts[0].id,'B-account');assert.equal(h.snapshot().fb.groupContent[0].id,'B-content');assert.equal(h.snapshot().fb.groupJobs[0].id,'B-job');
});
test('A to B to A discards both late responses even when the workspace string matches again',async()=>{
 const gates=[],started=[];let count=0;const h=harness(async path=>{if(path.startsWith('/api/state'))return state;const call=++count;let release,start;const gate=new Promise(r=>release=r);gates.push(release);started[call]?.();await gate;return {identity:'response-'+call};});
 const a=h.load();await new Promise(r=>setImmediate(r));const b=h.choose('B');await new Promise(r=>setImmediate(r));const back=h.choose('A');await new Promise(r=>setImmediate(r));gates[2]();await back;gates[0]();gates[1]();await Promise.all([a,b]);assert.deepEqual(h.renders,[{workspace:'A',identity:'response-3'}]);
});
test('same workspace account refresh discards the in-flight old identity',async()=>{
 let release,start,identity='Old Page',count=0;const gate=new Promise(r=>release=r),started=new Promise(r=>start=r);const h=harness(async path=>{if(path.startsWith('/api/state'))return state;const snapshot=identity;if(++count===1){start();await gate;}return {identity:snapshot};});const old=h.load();await started;identity='Selected XHS';await h.load();release();await old;assert.deepEqual(h.renders,[{workspace:'A',identity:'Selected XHS'}]);
});
test('wrong ownership and failed new customer reads remove old data and show a retryable error',async()=>{
 for(const response of [{accounts:[{workspace:'A',id:'old'}]},Error('fixture connection failed')]){const h=harness(async path=>{if(path.startsWith('/api/state'))return state;if(response instanceof Error)throw response;return response;});await h.choose('B');assert.equal(h.snapshot().fb,null);assert.equal(h.snapshot().loadedWorkspace,null);assert.deepEqual(h.renders,[]);assert.match(h.loading.at(-1).error,/其他客户|connection failed/);}
});
test('old failures never replace a successfully loaded new customer',async()=>{
 let release,start;const gate=new Promise(r=>release=r),started=new Promise(r=>start=r);const h=harness(async path=>{if(path.startsWith('/api/state'))return state;if(path.includes('workspace=A')){start();await gate;throw Error('old failure');}return {identity:'B'};});const a=h.load();await started;await h.choose('B');release();await a;assert.deepEqual(h.renders,[{workspace:'B',identity:'B'}]);assert.ok(!h.loading.some(x=>x.error==='old failure'));
});
test('a removed saved customer returns to the customer picker without retaining its data',async()=>{
 const switchSource=source.slice(source.indexOf('function switchWorkspace('),source.indexOf('async function load({'));
 const loadSource=source.slice(source.indexOf('async function load({'),source.indexOf('async function post('));
 const writes=[],loading=[];
 const h=new Function('get','writes','loading','AbortController',`let loadEpoch=0,loadController=null,loadedWorkspace=null,workspaceEpoch=0,core={workspaces:[{id:'available'}]},fb={identity:'old'},workspace='removed',route='settings',libraryWorkspace='',libraryItems=[],libraryPicked=new Set(),selectedContents=new Set(['old']),message='',catalogueReadError='',librarySummary=false,libraryPage=0,libraryQuery='',libraryMatches=null,librarySearchTimer=null,librarySearchController=null,libraryDetails=new Map(),verification,wechatInventory,wechatBrowserStatus;const localStorage={setItem:(key,value)=>writes.push([key,value])};const preservePublisherPlatform=()=>{},preserveSourceEdits=()=>{};const showWorkspaceLoading=error=>loading.push({workspace,error,fb,selected:[...selectedContents]});const render=()=>loading.push({rendered:workspace});${switchSource}${loadSource};return {load,snapshot:()=>({workspace,fb,loadedWorkspace,selected:[...selectedContents]})};`)(async path=>{if(path==='/api/state?workspace=removed')throw Error('客户不存在');return {workspaces:[{id:'available'}]};},writes,loading,AbortController);
 await h.load();assert.deepEqual(h.snapshot(),{workspace:'',fb:null,loadedWorkspace:'',selected:[]});assert.deepEqual(writes,[['v2.workspace','']]);assert.deepEqual(loading.at(-1),{rendered:''});
});
test('actual customer switch clears old selection and data before starting the new request',()=>{
 const switchSource=source.slice(source.indexOf('function switchWorkspace('),source.indexOf('async function load({'));const events=[];
 const h=new Function('events',`let workspace='A',workspaceEpoch=0,fb={identity:'A'},loadedWorkspace='A',verification={},wechatInventory={},wechatBrowserStatus={},selectedContents=new Set(['old']),libraryPicked=new Set(['old']),libraryItems=[{}],libraryWorkspace='A',message='',catalogueReadError='',librarySummary=false,libraryPage=0,libraryQuery='',libraryMatches=null,librarySearchTimer=null,librarySearchController=null,libraryDetails=new Map();const localStorage={setItem(){}};const preservePublisherPlatform=()=>{},preserveSourceEdits=()=>{};const showWorkspaceLoading=()=>events.push({workspace,fb,selected:[...selectedContents],library:[...libraryPicked]});const load=()=>events.push('request');${switchSource};return {switchWorkspace};`)(events);h.switchWorkspace('B');assert.deepEqual(events,[{workspace:'B',fb:null,selected:[],library:[]},'request']);
});

test('late local preparation response cannot choose old content or refresh the new customer',async()=>{
 const code=source.slice(source.indexOf('async function post('),source.indexOf('async function reconcileGroupJob('));let release,calls=0;const gate=new Promise(r=>release=r);const context=new Function('fetch','gate','record',`let workspace='A',workspaceEpoch=0,loadedWorkspace='A',core={token:'fixture'},message='';const contextualUrl=path=>path;const load=async()=>record();${code};return {post,request,switch:()=>{workspace='B';workspaceEpoch++;loadedWorkspace='B';},loading:()=>loadedWorkspace=null,message:()=>message};`)(async()=>{await gate;return {ok:true,json:async()=>({id:'A-content'})};},gate,()=>calls++);const pending=context.post('/api/workspaces/A/content',{});context.switch();release();await assert.rejects(pending,/旧操作响应已丢弃/);assert.equal(calls,0);assert.equal(context.message(),'');context.loading();await assert.rejects(context.request('/api/workspaces/B/content',{}),/仍在加载/);
});
