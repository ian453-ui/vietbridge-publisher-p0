import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {setup} from './helpers/scoped-fixture.js';
import {BrowserSkillClient,assertBrowserSkillBinding,validateBrowserSkillBinding} from '../src/browser-skill-binding.js';
import {BrowserSkillFacebook,readbackEvidence} from '../src/browser-skill-facebook.js';
import {scopeDigest} from '../src/task-action-permit.js';
import {guardBrowserSkillScan} from '../maintenance/browser-skill-policy.mjs';

import {runtime,candidate,mockClient,identity} from './helpers/browser-skill-fixture.js';
test('selected instance binding needs no local directory and cannot accept fake path-based authority',t=>{
 const f=setup(t),b=runtime(f);assert.equal(validateBrowserSkillBinding(b),b);assert.equal(assertBrowserSkillBinding(f.store.db,b).profileId,'bsk:e91ba5d3');
 for(const patch of [{browser_instance_id:''},{root_inode:'0'},{root_path:'/arbitrary/fake/profile'},{expires_at:b.issued_at+28800001},{evidence:{...b.evidence,source:'INFERRED_FROM_CONNECTED_BROWSER'}},{execute:true},{actor_id:'999'}])assert.throws(()=>assertBrowserSkillBinding(f.store.db,{...b,...patch}));
 assert.throws(()=>assertBrowserSkillBinding(f.store.db,b,{now:b.expires_at}),/EXPIRED/);
});
test('CLI uses explicit instance, argv and no auto-start; missing/wrong/busy instances never fall back',async()=>{
 const calls=[],client=new BrowserSkillClient({executable:'/mock/bsk',run:async(file,args,options)=>{calls.push({file,args,options});return {stdout:JSON.stringify(args[0]==='status'?{browsers:[{instance_id:'e91ba5d3'}],sessions:[]}:{session_id:'mock',browser_instance_id:'e91ba5d3',interaction:{borrow_confirmation:'always',request_help:'enabled'}})};}});
 assert.equal(await client.start('e91ba5d3'),'mock');assert.ok(calls[1].args.includes('--browser'));assert.ok(calls[1].args.includes('e91ba5d3'));assert.ok(calls.every(c=>c.options.env.BSK_AUTO_START==='0'&&c.options.shell===false));
 for(const status of [{browsers:[],sessions:[]},{browsers:[{instance_id:'e91ba5d3',unresponsive:true}],sessions:[]},{browsers:[{instance_id:'e91ba5d3',version_skew:true}],sessions:[]},{browsers:[{instance_id:'e91ba5d3'}],sessions:[{browser_instance_id:'e91ba5d3'}]}]){
  let n=0;const blocked=new BrowserSkillClient({executable:'/mock/bsk',run:async()=>{n++;return {stdout:JSON.stringify(status)};}});await assert.rejects(blocked.start('e91ba5d3'));assert.equal(n,1);
 }
});
test('scoped BSK reply consumes original durable permit once, in owned instance tabs with frozen UNKNOWN/lease preserved',async t=>{
 const f=setup(t),b=runtime(f),{post,reply}=candidate(f),old=f.makePage('Frozen 009'),oldAttempt='frozen-attempt';f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id=? WHERE id=?").run(oldAttempt,old.id);
 const release=f.executor.resources.acquire(f.profile.user_data_dir,'operator:'+f.profile.id,()=>true);release();const lease=join(f.root,'locks',readdirSync(join(f.root,'locks'))[0],'owner.json'),beforeLease=readFileSync(lease),beforeJob=f.publisher.job(f.w.id,old.id),client=mockClient(b,post);
 f.facebook.browserSkill=new BrowserSkillFacebook(f.store,{binding:b,client});const cap=f.scoped.capability('INTERACTION',post.id,reply);assert.equal(cap.canExecute,true,cap.reason);assert.equal(cap.actionScope.transport,'BROWSER_SKILL');assert.equal(cap.actionScope.profile_id,'bsk:e91ba5d3');
 assert.throws(()=>scopeDigest({...cap.actionScope,kind:'PAGE',actions:['PUBLISH']}),/UNSUPPORTED/);
 const input={confirm:true,scope_hash:cap.scopeHash,reply_body:reply,ack_group_rules:true};const result=await f.scoped.executeInteraction(f.w.id,post.id,input);
 assert.equal(client.submits,1);assert.equal(result.actions[0].state,'CONFIRMED');assert.equal(JSON.parse(result.actions[0].evidence_json).comment_id,'12399');assert.equal(client.stops,1);
 assert.equal(f.scoped.permits.read('INTERACTION:'+post.id).status,'CONSUMED');assert.equal(f.scoped.capability('INTERACTION',post.id,reply).canExecute,false);
 await assert.rejects(f.scoped.executeInteraction(f.w.id,post.id,input));assert.equal(client.submits,1);assert.deepEqual(f.publisher.job(f.w.id,old.id),beforeJob);assert.deepEqual(readFileSync(lease),beforeLease);
});
test('old Page directory is irrelevant to a new owned-instance interaction, while old CDP operation stays blocked',t=>{
 const f=setup(t),b=runtime(f),{post,reply}=candidate(f),old=f.makePage();f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',snapshot_json=json_set(snapshot_json,'$.profileDir',?) WHERE id=?").run('/unknown/legacy/path',old.id);
 const before=JSON.stringify(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id));
 f.facebook.browserSkill=new BrowserSkillFacebook(f.store,{binding:b,client:mockClient(b,post)});assert.equal(f.scoped.capability('INTERACTION',post.id,reply).canExecute,true);
 assert.equal(f.scoped.capability('PAGE',old.id).canExecute,false);assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id)),before);
});
for(const scenario of ['ambiguous','wrongIdentity','fill','submit','readback','wrongReadback'])test('BSK fail-closed '+scenario+' never retries a dispatched reply',async t=>{
 const f=setup(t),b=runtime(f),{post,reply}=candidate(f),client=mockClient(b,post,{ambiguous:scenario==='ambiguous',wrongIdentity:scenario==='wrongIdentity',wrongReadback:scenario==='wrongReadback',failAt:['fill','submit','readback'].includes(scenario)?scenario:null});f.facebook.browserSkill=new BrowserSkillFacebook(f.store,{binding:b,client});
 const cap=f.scoped.capability('INTERACTION',post.id,reply);assert.equal(cap.canExecute,true,cap.reason);const input={confirm:true,scope_hash:cap.scopeHash,reply_body:reply,ack_group_rules:true};
 let result;try{result=await f.scoped.executeInteraction(f.w.id,post.id,input);}catch{}
 const submitted=['submit','readback','wrongReadback'].includes(scenario);assert.equal(client.submits,submitted?1:0);assert.equal(f.scoped.permits.read('INTERACTION:'+post.id).status,'CONSUMED');
 const actions=f.store.rows('engagement_actions',f.w.id);assert.equal(actions[0].state,submitted?'RECONCILE_PENDING':'FAILED_CONFIRMED_ABSENT');assert.equal(f.scoped.capability('INTERACTION',post.id,reply).canExecute,false);await assert.rejects(f.scoped.executeInteraction(f.w.id,post.id,input));assert.equal(client.submits,submitted?1:0);
});
test('manual BSK scan guard rejects wrong principal/account/window and readback requires exact author/comment ID',t=>{
 const f=setup(t),b=runtime(f),s={workspace:b.workspace,account_id:b.account_id,actor_id:b.actor_id,target_page_id:b.target_page_id,issued_at:b.issued_at,expires_at:b.expires_at},context={url:new URL(`/api/workspaces/${b.workspace}/proactive/scan`,'http://127.0.0.1'),input:{account_id:b.account_id},principal:{type:'admin'}};
 assert.equal(guardBrowserSkillScan(context,b,s,f.dbPath),true);for(const c of [{...context,principal:{type:'app'}},{...context,input:{account_id:'wrong'}},{...context,input:{account_id:b.account_id,auto_execute:true}}])assert.throws(()=>guardBrowserSkillScan(c,b,s,f.dbPath));
 assert.throws(()=>guardBrowserSkillScan(context,b,s,f.dbPath,{now:b.expires_at}));
 const target={groupId:'12345',postId:'56789',permalink:'https://www.facebook.com/groups/12345/posts/56789/'},doc={url:target.permalink,navLinks:identity(b),target:{comments:[{body:'reply',links:[{url:target.permalink+'?comment_id=99'},{url:`https://www.facebook.com/${b.actor_id}`}]}]}};
 assert.equal(readbackEvidence(doc,target,{action_type:'INITIAL_REPLY'},'reply',b).comment_id,'99');assert.throws(()=>readbackEvidence({...doc,target:{comments:[...doc.target.comments,{...doc.target.comments[0],links:[{url:target.permalink+'?comment_id=100'},{url:`https://www.facebook.com/${b.actor_id}`}]}]}},target,{action_type:'INITIAL_REPLY'},'reply',b));
});
