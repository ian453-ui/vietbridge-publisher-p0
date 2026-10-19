import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {classifyEngagementPost,detectLanguage,isNegativeReply,stablePostFingerprint} from '../src/proactive-engagement.js';

function setup(){const store=new Store(join(mkdtempSync(join(tmpdir(),'smo-proactive-')),'db.sqlite')),workspace='ws-vietbridge',profile=store.saveProfile(workspace,{name:'FB',cdp_port:19521,user_data_dir:'/tmp/proactive-profile'}),account=store.saveAccount(workspace,{display_name:'VB',expected_identity:'VB',external_id:'123456',profile_id:profile.id}),group=store.addGroup(workspace,{account_id:account.id,name:'Vietnam Factory HR',url:'https://facebook.com/groups/123',tags:'越南工厂,招聘',proactive_engagement_enabled:true});store.db.prepare("UPDATE facebook_accounts SET session_health='HEALTHY' WHERE id=?").run(account.id);store.saveProactiveSettings(workspace,{account_id:account.id,enabled:true,auto_like:true,auto_reply:true,project_topics:'越南工厂,招聘'});return {store,workspace,account,group};}

test('new Facebook accounts automatically receive disabled limited-auto capability',()=>{const store=new Store(join(mkdtempSync(join(tmpdir(),'smo-proactive-account-')),'db.sqlite')),workspace='ws-vietbridge';try{const profile=store.saveProfile(workspace,{name:'Future account',cdp_port:19520,user_data_dir:'/tmp/proactive-account-profile'}),account=store.saveAccount(workspace,{display_name:'Future',expected_identity:'Future',profile_id:profile.id}),settings=store.proactiveSettings(workspace,account.id);assert.equal(settings.mode,'LIMITED_AUTO');assert.equal(settings.enabled,false);assert.equal(settings.auto_like,false);assert.equal(settings.auto_reply,false);assert.equal(settings.global_enabled,true);assert.equal(settings.account_enabled,true)}finally{store.close()}});

test('classifies ads, low-value and useful questions independently of company names',()=>{
  const context={project_topics:['越南工厂','招聘'],group_relevant:true};
  assert.equal(classifyEngagementPost({body:'优惠促销，加微信下单'},context).classification,'ADVERTISEMENT');
  assert.equal(classifyEngagementPost({body:'up'},context).classification,'LOW_VALUE');
  const useful=classifyEngagementPost({body:'我们公司在越南工厂招聘很慢，请问大家如何改善面试到岗率？'},context);
  assert.equal(useful.classification,'VALID');assert.equal(useful.action,'LIKE_AND_REPLY');assert.equal(useful.language,'zh');
});

test('detects Chinese, Vietnamese and English plus negative stop phrases',()=>{
  assert.equal(detectLanguage('请问在越南怎么办？'),'zh');
  assert.equal(detectLanguage('Cho hỏi làm sao tuyển người ở Việt Nam?'),'vi');
  assert.equal(detectLanguage('How can a factory improve hiring?'),'en');
  assert.equal(isNegativeReply('đừng trả lời nữa'),true);
  assert.equal(isNegativeReply("don't reply again"),true);
});

test('fingerprint is stable when a Facebook post id is unavailable',()=>{
  const a={group_id:'g',author:'A',body:'  hello   world ',timestamp:'2026-09-29T10:00:00Z'};
  assert.equal(stablePostFingerprint(a),stablePostFingerprint({...a,body:'hello world'}));
});

test('LIKE_AND_REPLY reserves one daily post slot and survives restart',()=>{
  const {store,workspace,account,group}=setup();const path=store.db.prepare('PRAGMA database_list').get().file;let reopened;
  try{
    const [post]=store.ingestEngagementPosts(workspace,account.id,[{group_id:group.id,external_id:'1',permalink:'https://facebook.com/groups/123/posts/1/',author:'Alice',body:'越南工厂招聘很慢，请问如何提高到岗率？',published_at:new Date().toISOString()}]);
    const plan=store.reserveProactivePost(workspace,post.id,'可以先拆开邀约、面试和到岗三个转化率，再定位流失最多的环节。');
    assert.deepEqual(plan.actions.map(x=>x.action_type),['LIKE','INITIAL_REPLY']);
    assert.equal(store.rows('engagement_daily_slots',workspace).length,1);
    store.finishProactiveAction(workspace,plan.actions[0].id,{readback_verified:true,liked:true});
    store.finishProactiveAction(workspace,plan.actions[1].id,{readback_verified:true,comment_id:'c1',replied:true});
    assert.equal(store.proactivePost(workspace,post.id).state,'LIKED_AND_REPLIED');
    assert.throws(()=>store.reserveProactivePost(workspace,post.id,'duplicate'),/不可执行/);
    store.close();reopened=new Store(path);
    assert.equal(reopened.rows('engagement_threads',workspace)[0].followup_count,0);
    assert.equal(reopened.rows('engagement_daily_slots',workspace)[0].state,'CONSUMED');
  }finally{try{store.close()}catch{}reopened?.close()}
});

test('fact-sensitive reply is blocked until a supporting source is recorded',()=>{
  const {store,workspace,account,group}=setup();try{
    const [post]=store.ingestEngagementPosts(workspace,account.id,[{group_id:group.id,external_id:'2',permalink:'https://www.facebook.com/groups/123/posts/2/',author:'Bob',body:'越南工厂最新劳动法规定怎么处理加班？',published_at:new Date().toISOString()}]);
    assert.equal(post.state,'FACT_REQUIRED');
    assert.throws(()=>store.reserveProactivePost(workspace,post.id,'draft'),/当前不可执行|事实/);
    store.addFactSource(workspace,post.id,{source_url:'https://example.gov.vn/rule',publisher:'Official',supports_reply:true});
    const plan=store.reserveProactivePost(workspace,post.id,'根据已核对的官方规则，需要先确认适用行业和生效日期。');
    assert.ok(plan.actions.some(x=>x.action_type==='INITIAL_REPLY'));
  }finally{store.close()}
});

test('UNKNOWN keeps the quota locked until reconcile proves absence',()=>{
  const {store,workspace,account,group}=setup();try{
    const [post]=store.ingestEngagementPosts(workspace,account.id,[{group_id:group.id,external_id:'3',permalink:'https://www.facebook.com/groups/123/posts/3/',author:'C',body:'越南工厂招聘怎么提升面试率？',published_at:new Date().toISOString()}]);
    const plan=store.reserveProactivePost(workspace,post.id,'先核对邀约到面试的流失环节。'),action=plan.actions[0];store.markProactiveUnknown(workspace,action.id,'readback timeout');
    assert.equal(store.proactivePost(workspace,post.id).state,'RECONCILE_PENDING');
    assert.equal(store.rows('engagement_daily_slots',workspace)[0].state,'RESERVED');
    assert.throws(()=>store.reserveProactivePost(workspace,post.id,'retry'),/UNKNOWN|不可执行|核对/);
    store.reconcileProactiveAction(workspace,action.id,{absence_proven:true,method:'fresh post readback'});
    assert.equal(store.proactivePost(workspace,post.id).state,'CANDIDATE');
  }finally{store.close()}
});

test('negative direct reply stops a thread and follow-ups cap at five',()=>{
  const {store,workspace,account,group}=setup();try{
    const [post]=store.ingestEngagementPosts(workspace,account.id,[{group_id:group.id,external_id:'4',permalink:'https://www.facebook.com/groups/123/posts/4/',author:'D',body:'越南工厂招聘怎么提高到岗率？',published_at:new Date().toISOString()}]);
    const plan=store.reserveProactivePost(workspace,post.id,'先拆分招聘漏斗。');for(const action of plan.actions)store.finishProactiveAction(workspace,action.id,{readback_verified:true,comment_id:action.action_type==='INITIAL_REPLY'?'c4':null});
    const thread=store.rows('engagement_threads',workspace)[0];
    store.recordThreadMessage(workspace,thread.id,{external_id:'x1',direction:'EXTERNAL',body:'别回复了',language:'zh'});
    assert.equal(store.rows('engagement_threads',workspace)[0].status,'STOPPED_NEGATIVE');
    assert.throws(()=>store.recordThreadMessage(workspace,thread.id,{external_id:'o1',direction:'OUTBOUND',body:'好的',language:'zh'}),/停止/);
  }finally{store.close()}
});
