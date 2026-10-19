import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setup} from './helpers/scoped-fixture.js';
import {wirePublication} from './helpers/browser-skill-publication-fixture.js';
import {ScopedOperations} from '../src/scoped-operations.js';

const confirmation=cap=>({confirm:true,scope_hash:cap.scopeHash});
function groupJob(f,contentId,url='https://www.facebook.com/groups/12345/'){
 const g=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Explicit joined',url});const [j]=f.store.createGroupJobs(f.w.id,{account_id:f.account.id,content_id:contentId,group_ids:[g.id]});return {g,j};
}
test('wired original Page flow: new frozen BSK snapshot -> original approve/assets -> atomic permit/claim -> one submit -> full readback',async t=>{
 const f=setup(t);let j;
 const {client}=wirePublication(f,{onStart:()=>{const row=f.publisher.job(f.w.id,j.id),permit=f.scoped.permits.read('PAGE:'+j.id);assert.equal(row.state,'PREPARING');assert.equal(permit.status,'CONSUMED');assert.equal(row.attempt_id,permit.attempt_id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_job_assets').get().n,1);}});
 j=f.makePage('Approved complete Page\nSecond paragraph',true);assert.equal(j.snapshot.transport,'BROWSER_SKILL');assert.equal(j.snapshot.profileDir,null);assert.equal(j.snapshot.cdpPort,null);assert.equal(j.snapshot.executionRef.instanceId,'e91ba5d3');assert.equal(j.snapshot.assetMetadata.length,1);
 const cap=f.executor.executionCapability(f.w.id,j.id);assert.equal(cap.canExecute,true,cap.reason);assert.equal(cap.requiresGroupRules,false);
 const result=await f.executor.execute(f.w.id,j.id,confirmation(cap));assert.equal(result.state,'PUBLISHED');assert.equal(result.evidence.mediaVerified,true);assert.equal(result.evidence.mediaCount,1);assert.equal(result.evidence.url,'https://www.facebook.com/61594159443807/posts/70001/');assert.equal(client.submits,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,1);await assert.rejects(f.executor.execute(f.w.id,j.id,confirmation(cap)));assert.equal(client.submits,1);assert.equal(f.executor.enabled,false);
 const second=f.makePage('Another Page',true);assert.equal(f.executor.executionCapability(f.w.id,second.id).reason,'PAGE_DAILY_LIMIT_1');
});
test('wired Group uses original group job, assets, claim, submit intent and published_posts; two groups maximum',async t=>{
 const f=setup(t),{client}=wirePublication(f),page=f.makePage('Approved group image',true),first=groupJob(f,page.content_id),second=groupJob(f,page.content_id,'https://www.facebook.com/groups/23456/');
 for(const {j} of [first,second]){assert.equal(j.profile_id,'bsk:e91ba5d3');const cap=f.scoped.capability('GROUP',j.id);assert.equal(cap.canExecute,true,cap.reason);assert.equal(cap.requiresGroupRules,true);const result=await f.scoped.executeGroup(f.w.id,j.id,{...confirmation(cap),ack_group_rules:true});assert.equal(result.state,'PUBLISHED');assert.equal(JSON.parse(result.evidence_json).readback.mediaVerified,true);assert.equal(f.scoped.permits.read('GROUP:'+j.id).attempt_id,result.attempt_id);}
 assert.equal(client.submits,2);assert.equal(client.calls.filter(c=>c[0]==='click'&&c[1]==='@e6').length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publication_intents').get().n,2);assert.equal(f.store.db.prepare('SELECT count(*) n FROM published_posts').get().n,2);
 const third=groupJob(f,page.content_id,'https://www.facebook.com/groups/34567/');assert.equal(f.scoped.capability('GROUP',third.j.id).reason,'GROUP_DAILY_LIMIT_2');await assert.rejects(f.scoped.executeGroup(f.w.id,first.j.id,{}));assert.equal(client.submits,2);
});
test('wrong confirmation/rules roll back original Group claim and do not create BSK session',async t=>{
 const f=setup(t),{client}=wirePublication(f),page=f.makePage('Approved image',true),{j}=groupJob(f,page.content_id),cap=f.scoped.capability('GROUP',j.id);
 await assert.rejects(f.scoped.executeGroup(f.w.id,j.id,confirmation(cap)),/GROUP_RULES/);assert.equal(f.store.job(f.w.id,j.id).state,'PENDING');assert.equal(f.scoped.permits.read('GROUP:'+j.id),undefined);assert.equal(client.starts,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,0);
});
test('old CDP UNKNOWN and lease bytes remain unchanged and conservatively block new publication',async t=>{
 const f=setup(t),old=f.makePage('Original009');f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='original-attempt' WHERE id=?").run(old.id);
 const release=f.executor.resources.acquire(f.profile.user_data_dir,'original',()=>true);release();const file=join(f.root,'locks',readdirSync(join(f.root,'locks'))[0],'owner.json'),lease=readFileSync(file),before=JSON.stringify(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id)),{client}=wirePublication(f),fresh=f.makePage('New approved image',true),cap=f.executor.executionCapability(f.w.id,fresh.id);
 assert.equal(cap.canExecute,false);await assert.rejects(f.executor.execute(f.w.id,fresh.id,{confirm:true,scope_hash:'0'.repeat(64)}));assert.equal(client.starts,0);assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id)),before);assert.deepEqual(readFileSync(file),lease);assert.equal(f.scoped.permits.read('PAGE:'+fresh.id),undefined);
});
for(const scenario of [{failAt:'submit'},{failAt:'readback'},{readbackMediaCount:0},{readbackTimes:[]},{readbackTimes:['View post']},{readbackTimes:[String(Math.floor(Date.now()/1000)-3600)]},{readbackTimes:['13 October at 20:00']},{readbackBody:'partial body'},{readbackUrl:'https://evil.example/61594159443807/posts/forged/'}])test('wired Page uncertain or incomplete publication stays UNKNOWN with consumed permit and PENDING instance lease '+JSON.stringify(scenario),async t=>{
 const f=setup(t),{client}=wirePublication(f,scenario),j=f.makePage('Full approved image',true),cap=f.executor.executionCapability(f.w.id,j.id);await assert.rejects(f.executor.execute(f.w.id,j.id,confirmation(cap)));assert.equal(f.publisher.job(f.w.id,j.id).state,'UNKNOWN');assert.equal(client.submits,1);assert.equal(f.scoped.permits.read('PAGE:'+j.id).status,'CONSUMED');await assert.rejects(f.executor.execute(f.w.id,j.id,confirmation(cap)));assert.equal(client.submits,1);const lease=JSON.parse(readFileSync(join(f.root,'locks',readdirSync(join(f.root,'locks'))[0],'owner.json')));assert.equal(lease.resource,'browser-skill-instance:e91ba5d3');assert.equal(lease.phase,'PENDING');
});
for(const point of ['fill','Next'])test('wired Page exact expiry after '+point+' blocks final Post and retains spent claim',async t=>{
 const f=setup(t);let clock=Date.now();const deadline=clock+1000,{client}=wirePublication(f,{now:()=>clock,policy:{expires_at:deadline},onEvent:(command,ref)=>{if(point==='fill'&&command==='fill'||point==='Next'&&ref==='@e6')clock=deadline;}}),j=f.makePage('Expiry image',true),cap=f.executor.executionCapability(f.w.id,j.id);
 await assert.rejects(f.executor.execute(f.w.id,j.id,confirmation(cap)),/EXPIRED/);assert.equal(client.submits,0);assert.equal(f.scoped.permits.read('PAGE:'+j.id).status,'CONSUMED');assert.equal(f.publisher.job(f.w.id,j.id).state,'UNKNOWN');
});
test('wired Page permits fresh readback after deadline crosses following its only final Post',async t=>{
 const f=setup(t);let clock=Date.now();const deadline=clock+1000,{client}=wirePublication(f,{now:()=>clock,policy:{expires_at:deadline},onEvent:(command,ref)=>{if(ref==='@e7')clock=deadline;}}),j=f.makePage('Post then expiry',true),cap=f.executor.executionCapability(f.w.id,j.id);
 assert.equal((await f.executor.execute(f.w.id,j.id,confirmation(cap))).state,'PUBLISHED');assert.equal(client.submits,1);assert.equal(f.scoped.permits.read('PAGE:'+j.id).status,'CONSUMED');
});
test('wrong visible actor blocks before form effects; binding or approved media changes block before BSK IPC',async t=>{
 const f=setup(t),{client,skill}=wirePublication(f,{wrongActor:true}),j=f.makePage('Actor image',true),cap=f.executor.executionCapability(f.w.id,j.id);await assert.rejects(f.executor.execute(f.w.id,j.id,confirmation(cap)),/ACTOR/);assert.equal(client.submits,0);assert.equal(f.publisher.job(f.w.id,j.id).state,'BLOCKED');
 const g=setup(t),wired=wirePublication(g),fresh=g.makePage('Pinned image',true);wired.skill.binding.browser_instance_id='a91ba5d3';assert.equal(g.executor.executionCapability(g.w.id,fresh.id).canExecute,false);assert.equal(wired.client.starts,0);
 const h=setup(t),media=wirePublication(h),changed=h.makePage('Changed bytes',true);writeFileSync(changed.snapshot.media[0],'changed');assert.equal(h.executor.executionCapability(h.w.id,changed.id).canExecute,false);assert.equal(media.client.starts,0);
});
for(const state of ['CLAIMED','SUBMITTING','UNKNOWN','PUBLISHED'])test('existing manual Page publication '+state+' is included in original quota/history',t=>{
 const f=setup(t);wirePublication(f);f.store.db.prepare("INSERT INTO records VALUES('manual_facebook_page_publication','native-011',?,?)").run(f.w.id,JSON.stringify({actor_id:f.account.operator_actor_id,business_page_id:f.account.target_page_id,state,created_at:new Date().toISOString(),body_sha256:'a'.repeat(64)}));const j=f.makePage('Another candidate image',true);assert.equal(f.executor.executionCapability(f.w.id,j.id).canExecute,false);assert.equal(f.scoped.permits.read('PAGE:'+j.id),undefined);
});
for(const scenario of [{failAt:'submit'},{failAt:'readback'},{readbackMediaCount:2},{wrongAuthor:true}])test('wired Group ambiguous or incomplete readback retains UNKNOWN/intent/permit and never retries '+JSON.stringify(scenario),async t=>{
 const f=setup(t),{client}=wirePublication(f,scenario),page=f.makePage('Complete group body',true),{j}=groupJob(f,page.content_id),cap=f.scoped.capability('GROUP',j.id),input={...confirmation(cap),ack_group_rules:true};
 await assert.rejects(f.scoped.executeGroup(f.w.id,j.id,input));assert.equal(client.submits,1);assert.equal(f.store.job(f.w.id,j.id).state,'UNKNOWN');assert.equal(f.scoped.permits.read('GROUP:'+j.id).status,'CONSUMED');assert.equal(f.store.db.prepare('SELECT count(*) n FROM publication_intents WHERE job_id=?').get(j.id).n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM published_posts WHERE job_id=?').get(j.id).n,0);await assert.rejects(f.scoped.executeGroup(f.w.id,j.id,input));assert.equal(client.submits,1);
});
test('wired Group changed URL or membership invalidates frozen scope before browser and grant',async t=>{
 const f=setup(t),{client}=wirePublication(f),page=f.makePage('Bound group',true),{j,g}=groupJob(f,page.content_id);
 f.store.db.prepare("UPDATE facebook_groups SET url='https://www.facebook.com/groups/999/' WHERE id=?").run(g.id);assert.equal(f.scoped.capability('GROUP',j.id).canExecute,false);await assert.rejects(f.scoped.executeGroup(f.w.id,j.id,{confirm:true,ack_group_rules:true,scope_hash:'0'.repeat(64)}));assert.equal(client.starts,0);assert.equal(f.scoped.permits.read('GROUP:'+j.id),undefined);
});
test('Page restart converts only its owned consumed attempt to UNKNOWN; renewed authority cannot replay it',async t=>{
 const f=setup(t),{client,policy}=wirePublication(f),j=f.makePage('Interrupted fresh Page',true),cap=f.executor.executionCapability(f.w.id,j.id),claimed=f.executor.claim(f.w.id,j.id,confirmation(cap));assert.equal(claimed.state,'PREPARING');
 const restart=new ScopedOperations(f.executor,f.facebook,{policy:{...policy,authorization:{...policy.authorization,approval_message_id:'different-authority'}},mediaRoots:[f.root],snapshotRoot:f.executor.snapshotRoot});restart.recoverStartup();assert.equal(f.publisher.job(f.w.id,j.id).state,'UNKNOWN');assert.equal(restart.permits.read('PAGE:'+j.id).status,'CONSUMED');assert.equal(restart.capability('PAGE',j.id).canExecute,false);assert.equal(client.starts,0);
});
test('selected scheduling mode must explicitly be Publish now before final Page click',async t=>{
 const f=setup(t),{client}=wirePublication(f,{publishNow:false}),j=f.makePage('Scheduling guard',true),cap=f.executor.executionCapability(f.w.id,j.id);await assert.rejects(f.executor.execute(f.w.id,j.id,confirmation(cap)),/NOW_DESTINATION/);assert.equal(client.submits,0);assert.equal(f.publisher.job(f.w.id,j.id).state,'UNKNOWN');assert.equal(f.scoped.permits.read('PAGE:'+j.id).status,'CONSUMED');
});
test('pending Group approval is never registered as a published post',async t=>{
 const f=setup(t),{client}=wirePublication(f,{pendingApproval:true}),p=f.makePage('Group pending approval',true),{j}=groupJob(f,p.content_id),cap=f.scoped.capability('GROUP',j.id);await assert.rejects(f.scoped.executeGroup(f.w.id,j.id,{...confirmation(cap),ack_group_rules:true}),/PENDING_PUBLICATION/);assert.equal(client.submits,1);assert.equal(f.store.job(f.w.id,j.id).state,'UNKNOWN');assert.equal(f.store.db.prepare('SELECT count(*) n FROM published_posts').get().n,0);
});
test('stored JOINED does not authorize writing when native Group membership is unknown',async t=>{
 const f=setup(t),{client}=wirePublication(f,{membership:'UNKNOWN'}),p=f.makePage('Live membership required',true),{j}=groupJob(f,p.content_id),cap=f.scoped.capability('GROUP',j.id);await assert.rejects(f.scoped.executeGroup(f.w.id,j.id,{...confirmation(cap),ack_group_rules:true}),/GROUP_TARGET/);assert.equal(client.submits,0);assert.equal(client.calls.some(c=>c[0]==='fill'||c[0]==='upload'),false);assert.equal(f.store.job(f.w.id,j.id).state,'FAILED');
});
test('existing legacy PENDING group cannot be silently refrozen or executed through new BSK authority',async t=>{
 const f=setup(t),p=f.makePage('Original legacy image',true),{j,g}=groupJob(f,p.content_id),before=JSON.stringify(f.store.job(f.w.id,j.id)),{client}=wirePublication(f);
 const [again]=f.store.createGroupJobs(f.w.id,{account_id:f.account.id,content_id:p.content_id,group_ids:[g.id]});assert.equal(again.id,j.id);assert.equal(again.was_created,false);assert.equal(JSON.stringify(f.store.job(f.w.id,j.id)),before);assert.equal(f.scoped.capability('GROUP',j.id).canExecute,false);await assert.rejects(f.scoped.executeGroup(f.w.id,j.id,{confirm:true,ack_group_rules:true,scope_hash:'0'.repeat(64)}));assert.equal(client.starts,0);assert.equal(JSON.stringify(f.store.job(f.w.id,j.id)),before);
});
