import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/scoped-fixture.js';
import {runtime,candidate,mockClient} from './helpers/browser-skill-fixture.js';
import {BrowserSkillFacebook} from '../src/browser-skill-facebook.js';

for(const scenario of ['both-after','both-equal','permit-only','policy-only'])test('fill crossing '+scenario+' deadline cannot dispatch or recover spent authority',async t=>{
 const f=setup(t),b=runtime(f),{post,reply}=candidate(f),client=mockClient(b,post);let clock=Date.now();const deadline=clock+1000,longDeadline=clock+60000;
 f.scoped.now=()=>clock;f.scoped.permits.now=()=>clock;
 f.scoped.policy.expires_at=scenario.startsWith('both')?deadline:longDeadline;f.scoped.permits.policy.expires_at=f.scoped.policy.expires_at;
 f.facebook.browserSkill=new BrowserSkillFacebook(f.store,{binding:b,client,now:()=>clock});
 const cap=f.scoped.capability('INTERACTION',post.id,reply);assert.equal(cap.canExecute,true,cap.reason);
 if(scenario==='permit-only')f.scoped.permits.issue(cap.actionScope,{expiresAt:deadline,authorization:f.policy.authorization});
 const input={confirm:true,scope_hash:cap.scopeHash,reply_body:reply,ack_group_rules:true},originalInput=client.input;
 client.input=async(...args)=>{const result=await originalInput(...args);if(args[2]==='fill'){if(scenario==='policy-only')f.scoped.policy.expires_at=deadline;clock=deadline+(scenario==='both-equal'?0:1);}return result;};
 await assert.rejects(f.scoped.executeInteraction(f.w.id,post.id,input),/CLAIMED_TASK_OR_PERMIT_EXPIRED/);
 assert.ok(clock>=deadline);assert.ok(clock<b.expires_at);assert.equal(client.submits,0);
 assert.equal(f.scoped.permits.read('INTERACTION:'+post.id).status,'CONSUMED');assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,1);
 assert.equal(f.store.db.prepare('SELECT state FROM engagement_actions WHERE post_id=?').get(post.id).state,'FAILED_CONFIRMED_ABSENT');
 const events=f.store.db.prepare('SELECT count(*) n FROM task_action_permit_events').get().n;await assert.rejects(f.scoped.executeInteraction(f.w.id,post.id,input));assert.equal(client.submits,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permit_events').get().n,events);
});
test('deadline crossed after dispatch permits exact read-only readback and confirmation, with no second submit',async t=>{
 const f=setup(t),b=runtime(f),{post,reply}=candidate(f),client=mockClient(b,post);let clock=Date.now();const deadline=clock+1000;
 f.scoped.now=()=>clock;f.scoped.permits.now=()=>clock;f.scoped.policy.expires_at=deadline;f.scoped.permits.policy.expires_at=deadline;
 f.facebook.browserSkill=new BrowserSkillFacebook(f.store,{binding:b,client,now:()=>clock});const cap=f.scoped.capability('INTERACTION',post.id,reply);assert.equal(cap.canExecute,true,cap.reason);
 const input={confirm:true,scope_hash:cap.scopeHash,reply_body:reply,ack_group_rules:true},originalInput=client.input;
 client.input=async(...args)=>{assert.ok(clock<deadline,'actual dispatch began before both deadlines');const result=await originalInput(...args);if(args[2]==='press')clock=deadline+1;return result;};
 const result=await f.scoped.executeInteraction(f.w.id,post.id,input);assert.equal(client.submits,1);assert.equal(result.actions[0].state,'CONFIRMED');assert.equal(JSON.parse(result.actions[0].evidence_json).comment_id,'12399');assert.ok(clock>=deadline);
 assert.throws(()=>f.scoped.assertClaimed('INTERACTION',post.id,input),/EXPIRED/);assert.equal(f.scoped.permits.read('INTERACTION:'+post.id).status,'CONSUMED');assert.equal(f.scoped.capability('INTERACTION',post.id,reply).canExecute,false);await assert.rejects(f.scoped.executeInteraction(f.w.id,post.id,input));assert.equal(client.submits,1);
});
