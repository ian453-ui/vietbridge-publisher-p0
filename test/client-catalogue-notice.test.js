import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
const update=source.slice(source.indexOf('async function checkGptUpdates('),source.indexOf('setInterval(()=>{if(['));
const load=source.slice(source.indexOf('async function load({'),source.indexOf('async function post('));

function updateHarness(get){
 const renders=[];
 const h=new Function('get','record',`let workspace='A',loadedWorkspace='A',loadEpoch=1,route='v1',gptUpdateBusy=false,gptUpdateWorkspace='',gptUpdateCheckedAt='',gptUpdateError='',libraryItems=[],libraryWorkspace='',librarySummary=false,libraryQuery='',libraryPicked=new Set(),selectedContents=new Set(),pendingLibraryScopes=new Set(),message='',catalogueReadError='';const render=()=>record(message);const libraryScope=()=>workspace;${update};return {checkGptUpdates,switchToB:()=>{workspace='B';loadedWorkspace='B';loadEpoch++},message:()=>message,error:()=>catalogueReadError,items:()=>libraryItems};`)(get,m=>renders.push(m));
 return {...h,renders};
}

test('successful background catalogue read clears an earlier manual timeout notice',async()=>{
 let fail=true;
 const h=updateHarness(async()=>{if(fail)throw Error('数据读取超时');return {items:[{key:'147',revision:'v1',ready:true}]}});
 await h.checkGptUpdates(true);
 assert.equal(h.message(),'更新失败：数据读取超时');
 fail=false;await h.checkGptUpdates();
 assert.equal(h.items().length,1);
 assert.equal(h.message(),'');
 assert.equal(h.error(),'');
 assert.equal(h.renders.at(-1),'');
});

test('late catalogue response from the previous customer cannot change current notice or items',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);
 const h=updateHarness(async()=>{await gate;return {items:[{key:'old-A',revision:'v1',ready:true}]}});
 const pending=h.checkGptUpdates();h.switchToB();release();await pending;
 assert.deepEqual(h.items(),[]);
 assert.equal(h.renders.length,0);
});

test('successful normal load clears only its own prior catalogue error',async()=>{
 let fail=true;
 const reads=async path=>{
  if(path.startsWith('/api/state'))return {workspaces:[{id:'A'}],unified:true};
  if(path.startsWith('/api/facebook'))return {accounts:[],publisherAccounts:[],profiles:[],groupContent:[],groupJobs:[]};
  if(fail)throw Error('数据读取超时');
  return {items:[{key:'ready'}]};
 };
 const h=new Function('get','AbortController',`let workspace='A',route='v1',loadEpoch=0,loadController=null,loadedWorkspace='A',core,fb,libraryWorkspace='',libraryItems=[],libraryPicked=new Set(),librarySearchTimer=null,librarySearchController=null,message='',catalogueReadError='',verification,wechatInventory,wechatBrowserStatus;const render=()=>{};const showWorkspaceLoading=()=>{};${load};return {load,notice:()=>message,setNotice:value=>message=value,items:()=>libraryItems};`)(reads,AbortController);
 await h.load();assert.match(h.notice(),/资料库暂不可用：数据读取超时/);
 fail=false;await h.load();assert.equal(h.items().length,1);assert.equal(h.notice(),'');
 h.setNotice('请先选择账号');await h.load();assert.equal(h.notice(),'请先选择账号');
});
