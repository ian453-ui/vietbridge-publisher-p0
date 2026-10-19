import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionConfirmation,confirmationScope,executionConfirmationView,validateExecutionConfirmation,executionButton} from '../src/unified-client.js';

test('default automatic and backup manual entries retain final confirmation',()=>{
 const f=fixture();f.job.state='READY';f.job.canExecute=true;f.job.execution={mode:'GLOBAL'};
 assert.match(executionButton(f.job),/确认并自动发布/);
 assert.doesNotMatch(executionButton(f.job),/data-execute-manual|手动触发发布（备用）/);assert.equal((executionButton(f.job).match(/data-execute=/g)||[]).length,1);
 assert.match(executionConfirmationView(f.job),/data-confirm-submit>确认并自动发布/);
 assert.match(executionConfirmationView(f.job,true),/data-confirm-submit>确认并手动触发发布/);
 f.job.state='UNKNOWN';assert.equal(executionButton(f.job),'');
});
test('WeChat execution labels truthfully describe draft writing',()=>{
 const f=fixture();Object.assign(f.job,{state:'READY',canExecute:true,execution:{mode:'GLOBAL'}});
 f.job.snapshot.platform='wechat_official_account';
 assert.match(executionButton(f.job),/确认并自动写入草稿/);
 assert.match(executionConfirmationView(f.job),/data-confirm-submit>确认并自动写入草稿/);
});

function fixture(){
  const job={id:'job',workspace:'ws',account_id:'account',content_id:'content',snapshot_hash:'frozen-hash',snapshot:{expectedIdentity:'LP',operatorActorId:'actor',targetPageId:'page',platform:'facebook',transport:'BROWSER',body:'Frozen <script> text',media:[]},execution:{mode:'SINGLE_USE',permitId:'permit',expiresAt:'2030-01-01T00:00:00Z'}};
  let current=true,posts=0,reads=0,attempts=0,capability={canExecute:true,state:'READY',attemptId:null,scope:confirmationScope(job),...job.execution,permitStatus:'AVAILABLE'},fail=false,wait;
  const model=new ExecutionConfirmation({job,isCurrent:()=>current,now:()=>Date.parse('2029-01-01'),readCapability:async()=>{if(wait)await wait;return capability;},submit:async()=>{posts++;if(fail)throw Error('network outcome unknown');},readback:async()=>{reads++;},onAttempt:()=>attempts++});
  return {job,model,get posts(){return posts;},get reads(){return reads;},get attempts(){return attempts;},set current(v){current=v;},set capability(v){capability=v;},get capability(){return capability;},set fail(v){fail=v;},set wait(v){wait=v;}};
}
test('opening and cancel/Esc model produce no POST and permit another visible confirmation',async()=>{
  const f=fixture();assert.equal(f.model.show(),true);assert.equal(f.posts,0);f.model.cancel();assert.equal(await f.model.confirm(),false);assert.equal(f.posts,0);assert.equal(f.model.show(),true);f.model.cancel();assert.equal(f.model.show(),true);assert.equal(f.attempts,0);
});
test('switch or rerender invalidates confirmation, including during read-only check',async()=>{
  const f=fixture();f.model.show();f.current=false;await assert.rejects(()=>f.model.confirm(),/失效/);assert.equal(f.posts,0);
  const g=fixture();let release;g.wait=new Promise(r=>release=r);g.model.show();const pending=g.model.confirm();g.model.cancel();release();await assert.rejects(()=>pending,/失效/);assert.equal(g.posts,0);
});
test('double final confirmation produces exactly one POST and one readback',async()=>{
  const f=fixture();f.model.show();const results=await Promise.all([f.model.confirm(),f.model.confirm(),f.model.confirm()]);assert.equal(results.filter(Boolean).length,1);assert.equal(f.posts,1);assert.equal(f.reads,1);assert.equal(f.attempts,1);assert.equal(f.model.show(),false);assert.equal(await f.model.confirm(),false);
});
test('every scope field/hash change, unavailable state, expired/consumed/replaced permit reject before submit',async()=>{
  const baseline=fixture();
  for(const key of Object.keys(baseline.capability.scope)){
    const f=fixture();f.capability={...f.capability,scope:{...f.capability.scope,[key]:key==='media_count'?1:'changed'}};f.model.show();await assert.rejects(()=>f.model.confirm(),/改变/);assert.equal(f.posts,0);
  }
  for(const patch of [{canExecute:false},{state:'UNKNOWN'},{attemptId:'previous'},{permitStatus:'CONSUMED'},{permitStatus:'REVOKED'},{expiresAt:'2020-01-01T00:00:00Z'},{expiresAt:'invalid'},{permitId:'new'},{mode:'GLOBAL'},{scope:null}]){
    const f=fixture();f.capability={...f.capability,...patch};f.model.show();await assert.rejects(()=>f.model.confirm());assert.equal(f.posts,0);assert.equal(f.attempts,0);
  }
  const f=fixture();f.job.execution.expiresAt='2020-01-01T00:00:00Z';f.capability={...f.capability,expiresAt:f.job.execution.expiresAt};assert.throws(()=>validateExecutionConfirmation(f.job,f.capability,Date.parse('2029-01-01')),/过期/);
});
test('unknown submit performs only readback and never automatically recovers a retry',async()=>{
  const f=fixture();f.fail=true;f.model.show();await assert.rejects(()=>f.model.confirm(),/unknown/);assert.equal(f.posts,1);assert.equal(f.reads,1);assert.equal(f.model.sent,true);assert.equal(f.model.show(),false);assert.equal(await f.model.confirm(),false);assert.equal(f.posts,1);
});
test('visible accessible dialog displays frozen content and complete identity/scope with escaped markup',()=>{
  const f=fixture(),html=executionConfirmationView(f.job);
  for(const value of ['execution-confirmation-title','role="status"','data-confirm-cancel','data-confirm-submit','确认并执行一次','LP','actor','page','BROWSER','job','frozen-hash','2030-01-01','&lt;script&gt;'])assert.ok(html.includes(value),value);
  assert.equal(html.includes('<script>'),false);
});
