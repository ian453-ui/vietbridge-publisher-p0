import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
const proactiveHandler=source.split('\n').find(line=>line.startsWith("document.addEventListener('click',async e=>{const by=id=>document.getElementById(id),account=selectedFacebookAccount();"));

test('pending readback is reported as pending, never as a confirmed interaction',async()=>{
 let handler;
 const context=vm.createContext({
  document:{addEventListener:(_event,fn)=>handler=fn,getElementById(){},querySelector:()=>({value:'Reviewed text'})},
  selectedFacebookAccount:()=>({id:'account-a'}),workspace:'ws',message:'',
  post:async()=>({state:'RECONCILE_PENDING'}),load:async()=>{},render(){}
 });
 vm.runInContext(proactiveHandler,context);
 const button={disabled:false,dataset:{executeProactive:'post-a'}};
 await handler({target:{id:'',closest:()=>button}});
 assert.match(context.message,/结果待核对/);assert.doesNotMatch(context.message,/已完成独立页面回读/);
});
test('scan failure is visible and the page re-renders for manual retry',async()=>{
 let handler,rendered=0;
 const context=vm.createContext({
  document:{addEventListener:(_event,fn)=>handler=fn,getElementById(){}},
  selectedFacebookAccount:()=>({id:'account-b'}),workspace:'ws',message:'',
  post:async()=>{throw Error('Facebook login required');},load:async()=>{},render:()=>rendered++
 });
 vm.runInContext(proactiveHandler,context);
 await handler({target:{id:'scan-proactive',disabled:false}});
 assert.match(context.message,/login required/);assert.equal(rendered,1);
});
test('fact-sensitive candidates expose a source verification form without an execute button',()=>{
 const account={id:'a',display_name:'Operating account',execution_transport:'BROWSER'};
 const context={selectedFacebookAccount:()=>account,esc:String,Date,fb:{
  proactiveSettings:[],facebookGroups:[],proactiveActions:[],proactiveThreads:[],proactiveDailySlots:[],
  proactivePosts:[{id:'post',account_id:'a',state:'FACT_REQUIRED',body:'Which visa rule applies?',reason:'Source required'}]
 }};
 const line=source.split('\n').find(line=>line.startsWith('function proactiveView()'));
 const html=vm.runInNewContext(line+'\nproactiveView()',context);
 assert.match(html,/data-save-fact="post"/);assert.doesNotMatch(html,/data-execute-proactive="post"/);
  assert.match(html,/Operating account/);
  assert.match(html,/id="proactive-mode"/);
});

test('topic view scopes candidates to the selected account and quota to the last 24 hours',()=>{
 const context={esc:String,Date,core:{executionEnabled:false},workspace:'ws',engagementEdits:new Map(),fb:{selectedAccountId:'a',accounts:[{id:'a',enabled:true}],engagementPolicies:[{account_id:'a',mode:'SHADOW'}],facebookComments:[],engagementCandidates:[{id:'mine',account_id:'a',state:'REPLY_CANDIDATE',risk:'LOW'},{id:'other',account_id:'b',state:'REPLY_CANDIDATE',risk:'LOW'}],quotaEvents:[{account_id:'a',operation:'REPLY',state:'CONSUMED',reserved_at:new Date().toISOString()},{account_id:'a',operation:'REPLY',state:'CONSUMED',reserved_at:'2000-01-01T00:00:00Z'},{account_id:'b',operation:'REPLY',state:'CONSUMED',reserved_at:new Date().toISOString()}]}};
 const line=source.split('\n').find(line=>line.startsWith('function engagementView()'));
 const helpers=['engagementEditKey','engagementCandidateCard'].map(name=>source.split('\n').find(row=>row.startsWith('function '+name+'('))).join('\n');
 const html=vm.runInNewContext(helpers+'\n'+line+'\nengagementView()',context);
 assert.match(html,/<strong>1\/12<\/strong>/);
 assert.match(html,/data-reserve-candidate="mine" disabled/);
 assert.doesNotMatch(html,/data-reserve-candidate="other"/);
});
