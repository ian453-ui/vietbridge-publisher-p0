import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {reviewFixtureCandidate} from './fixtures/review-engagement.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {ScanScheduler} from '../src/scan-scheduler.js';
function setup(t){
  const root=mkdtempSync(join(tmpdir(),'vb-interaction-')),store=new Store(join(root,'db.sqlite'),{seedDemo:false});new UnifiedPublisher(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const ws=store.saveWorkspace({name:'Client'}).id,profile=store.saveProfile(ws,{name:'Chrome',cdp_port:19811,user_data_dir:join(root,'chrome')}),account=store.saveAccount(ws,{display_name:'Page',profile_id:profile.id,expected_identity:'Page',external_id:'12345'}),group=store.addGroup(ws,{account_id:account.id,name:'越南工厂',tags:'越南工厂,招聘',url:'https://www.facebook.com/groups/111',proactive_engagement_enabled:true});
  store.db.prepare("UPDATE facebook_accounts SET session_health='HEALTHY' WHERE id=?").run(account.id);
  store.saveEngagementPolicy(ws,{account_id:account.id,mode:'AUTO_LOW_RISK',topics:'越南工厂',daily_reply_limit:1,group_daily_limit:3,author_weekly_limit:2});
  store.saveProactiveSettings(ws,{account_id:account.id,enabled:true,auto_like:true,auto_reply:true,project_topics:'越南工厂'});
  const proactive=(id='777',author='Alice')=>store.ingestEngagementPosts(ws,account.id,[{group_id:group.id,external_id:id,permalink:`https://www.facebook.com/groups/111/posts/${id}/`,author,body:'我们公司在越南工厂招聘很慢，请问大家如何改善面试到岗率？',published_at:new Date().toISOString()}])[0];
  return {store,ws,account,group,proactive};
}
test('topic and proactive replies share account limits and cannot reserve the same post twice',t=>{
  const f=setup(t),post=f.proactive();f.store.ingestRadarPosts(f.ws,f.account.id,[{group_id:f.group.id,external_id:'777',permalink:post.permalink,author:'Alice',body:'越南工厂怎么提高到岗率？',topic:'越南工厂'}]);
  const candidate=f.store.buildEngagementCandidates(f.ws,f.account.id).find(x=>x.state==='REPLY_CANDIDATE');
  reviewFixtureCandidate(f.store,f.ws,candidate);
  const held=f.store.reserveReplyQuota(f.ws,candidate.id);
  assert.throws(()=>f.store.reserveProactivePost(f.ws,post.id,'已审核的回复'),e=>e.code==='TARGET_ALREADY_RESERVED');
  assert.equal(f.store.rows('engagement_actions',f.ws).length,0,'transaction must roll back partial LIKE reservation');
  f.store.releaseQuota(f.ws,held.reservation.id);
  const plan=f.store.reserveProactivePost(f.ws,post.id,'已审核的回复');assert.equal(plan.actions.length,2);
  assert.equal(f.store.quotaStatus(f.ws,f.account.id).remaining,0);
});
test('partial success retries only the definitely unsubmitted remainder',t=>{
  const f=setup(t),post=f.proactive(),plan=f.store.reserveProactivePost(f.ws,post.id,'已审核的回复');
  f.store.finishProactiveAction(f.ws,plan.actions[0].id,{readback_verified:true,liked:true});
  f.store.failProactiveBeforeSubmit(f.ws,post.id,'回复填充失败，未按 Enter');
  assert.equal(f.store.proactivePost(f.ws,post.id).state,'PARTIAL_RETRY');
  f.proactive();assert.equal(f.store.proactivePost(f.ws,post.id).state,'PARTIAL_RETRY','a new scan must preserve partial execution state');
  const resumed=f.store.reserveProactivePost(f.ws,post.id,'重新审核的回复');
  assert.deepEqual(resumed.actions.map(x=>x.action_type),['INITIAL_REPLY']);
  assert.equal(f.store.rows('engagement_daily_slots',f.ws).length,1);
});
test('scheduler stop waits for in-flight discovery and prevents another tick',async t=>{
  const f=setup(t);let resume,scans=0;
  const wait=new Promise(resolve=>{resume=resolve;});
  const scheduler=new ScanScheduler(f.store,{scanProactiveEngagement:async()=>{scans++;await wait;}});
  const tick=scheduler.tick();let stopped=false;
  const drain=scheduler.stop().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);resume();await tick;await drain;
  assert.equal(stopped,true);await scheduler.tick();assert.equal(scans,1);
});
test('uncertain LIKE leaves unstarted reply retryable only after real readback',t=>{
  const f=setup(t),post=f.proactive(),plan=f.store.reserveProactivePost(f.ws,post.id,'已审核的回复');
  f.store.markProactiveUnknown(f.ws,plan.actions[0].id,'click interrupted');
  assert.equal(f.store.proactiveAction(f.ws,plan.actions[1].id).state,'FAILED_CONFIRMED_ABSENT');
  assert.throws(()=>f.store.reserveProactivePost(f.ws,post.id,'retry'),/不可执行/);
  f.store.reconcileProactiveAction(f.ws,plan.actions[0].id,{found:true,liked:true});
  assert.equal(f.store.proactivePost(f.ws,post.id).state,'PARTIAL_RETRY');
  assert.deepEqual(f.store.reserveProactivePost(f.ws,post.id,'继续已审核回复').actions.map(x=>x.action_type),['INITIAL_REPLY']);
});
test('scan scheduler obeys persisted intervals and never executes interaction actions',async t=>{
  const f=setup(t);let now=1000,scans=0;
  const facebook={scanProactiveEngagement:async()=>{scans++;},executeProactiveEngagement(){throw Error('must not execute');}};
  const first=new ScanScheduler(f.store,facebook,{now:()=>now});await first.tick();assert.equal(scans,1);
  const second=new ScanScheduler(f.store,facebook,{now:()=>now});await second.tick();assert.equal(scans,1);
  now+=61*60000;await second.tick();assert.equal(scans,2);
  f.store.saveProactiveSettings(f.ws,{account_id:f.account.id,enabled:false});now+=61*60000;await second.tick();assert.equal(scans,2);
});
