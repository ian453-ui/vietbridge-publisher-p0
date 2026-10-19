import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PublisherFormDrafts,publisherPayload} from '../src/publisher-form-state.js';

test('021 uses user-confirmed tags without overriding edits or leaking to other posts',()=>{
 const content={library_source:{article_id:'CNVISA-FB-021'},body:'caption'};
 assert.deepEqual(publisherPayload(content,'facebook').tags,['LPTravel','VisaTrungQuoc','TetDuongLich2027']);
 assert.deepEqual(publisherPayload(content,'facebook',{tags:['Edited']}).tags,['Edited']);
 assert.deepEqual(publisherPayload(content,'wechat_official_account').tags,[]);
 assert.deepEqual(publisherPayload({library_source:{article_id:'CNVISA-FB-001'}},'facebook').tags,[]);
});

test('manual edits and current selection survive remount and stay isolated',()=>{
 const state=new PublisherFormDrafts(),tags=['LPTravel'];
 state.set('lp','facebook','021',{title:'corrected',body:'body',author:'LP Travel Visa',tags});
 tags.push('wrong');
 assert.equal(state.selected('lp','facebook'),'021');
 assert.deepEqual(state.get('lp','facebook','021').tags,['LPTravel']);
 for(const scope of [['other','facebook','021'],['lp','wechat','021'],['lp','facebook','old']])
  assert.equal(state.get(...scope),undefined);
 state.select('lp','facebook','old');
 assert.equal(state.get('lp','facebook','021').author,'LP Travel Visa');
});

const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
test('new import supersedes old selection but remount does not undo manual selection',()=>{
 const state=new PublisherFormDrafts(),rows=[{id:'old'},{id:'021'},{id:'022'}];
 state.select('lp','fb','old');
 assert.equal(state.resolve('lp','fb','021',rows),'021');
 state.select('lp','fb','old');
 assert.equal(state.resolve('lp','fb','021',rows),'old');
 assert.equal(state.resolve('lp','fb','022',rows),'022');
});
const importFunction=source.split('\n').find(x=>x.startsWith('async function importLibrary('));
function context(request){
 const ctx=vm.createContext({workspace:'lp',loadEpoch:0,core:{unified:true},selectedPublishingAccount:()=>({id:'account'}),
 libraryItems:[{key:'021',revision:2}],libraryPicked:new Set(['021']),selectedContents:new Set(['old']),
 request,message:'',render(){},load:async()=>{},Set,JSON});
 vm.runInContext(importFunction,ctx);return ctx;
}
test('import selects only requested new content, without intermediate post reload',async()=>{
 const ctx=context(async()=>({contents:[{id:'new021'}]}));
 await vm.runInContext('importLibrary({isConnected:true})',ctx);
 assert.deepEqual([...ctx.selectedContents],['new021']);
});
test('late import response cannot overwrite a changed library selection',async()=>{
 let finish;const ctx=context(()=>new Promise(resolve=>finish=resolve));
 const promise=vm.runInContext('importLibrary({isConnected:true})',ctx);
 ctx.libraryPicked.clear();finish({contents:[{id:'new021'}]});await promise;
 assert.deepEqual([...ctx.selectedContents],['old']);
});
test('failed import is shown and does not replace content',async()=>{
 const ctx=context(async()=>{throw Error('offline');});
 await vm.runInContext('importLibrary({isConnected:true})',ctx);
 assert.match(ctx.message,/offline/);assert.deepEqual([...ctx.selectedContents],['old']);
});
