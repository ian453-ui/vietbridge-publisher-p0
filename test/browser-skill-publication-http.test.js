import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/scoped-fixture.js';
import {wirePublication} from './helpers/browser-skill-publication-fixture.js';
import {configFor,cloudFor} from './helpers/scoped-wrapper-fixture.js';
import {createControlledApp} from '../maintenance/controlled-app.mjs';
import {createApp} from '../src/server.js';
import {scopeDigest} from '../src/task-action-permit.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

test('normal admin/CSRF/exact fixed-target Page and Group HTTP paths dispatch original mock BSK carrier with all automation flags off',async t=>{
 const f=setup(t),{binding,client}=wirePublication(f),page=f.makePage('HTTP approved image\nFull body',true),group=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Explicit joined group',url:'https://www.facebook.com/groups/12345/'}),[job]=f.store.createGroupJobs(f.w.id,{account_id:f.account.id,content_id:page.content_id,group_ids:[group.id]}),pc=f.scoped.capability('PAGE',page.id),gc=f.scoped.capability('GROUP',job.id);
 assert.equal(pc.canExecute,true,pc.reason);assert.equal(gc.canExecute,true,gc.reason);
 const {config}=configFor(f,[{kind:'PAGE',id:page.id,scope_hash:pc.scopeHash},{kind:'GROUP',id:job.id,scope_hash:gc.scopeHash}]);config.scopeAuthorization.profile_id='bsk:e91ba5d3';config.scopeAuthorization.operations=['PAGE','GROUP'];config.browserSkillBinding=binding;
 const cloud=cloudFor(f),server=createControlledApp(createApp,f.dbPath,{config,head:'b'.repeat(40),scopeDigest,cloud,browserSkillClient:client,library:{roots:[f.root],snapshotRoot:f.root,gptInboxBase:null}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const login=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cloud.user,password:cloud.password}),redirect:'manual'});assert.equal(login.status,303);
 const cookie=login.headers.get('set-cookie').split(';')[0],state=await (await fetch(origin+'/api/state?workspace='+f.w.id,{headers:{cookie}})).json();
 const post=(path,input,headers={})=>fetch(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-local-token':state.token,...headers},body:JSON.stringify(input)});
 const pp=`/api/unified/workspaces/${f.w.id}/jobs/${page.id}/execute`,gp=`/api/workspaces/${f.w.id}/group-jobs/auto-publish`,pi={confirm:true,scope_hash:pc.scopeHash},gi={job_ids:[job.id],confirm:true,scope_hash:gc.scopeHash,ack_group_rules:true};
 assert.equal((await post(pp,pi,{cookie:''})).status,401);assert.equal((await post(pp,pi,{'x-local-token':'bad'})).status,409);assert.equal((await post(pp,{...pi,execute_all:true})).status,409);assert.equal((await post(gp,{...gi,ack_group_rules:false})).status,409);assert.equal(client.starts,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permits').get().n,0);
 let r=await post(pp,pi);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'PUBLISHED');assert.equal(client.submits,1);
 r=await post(gp,gi);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).jobs[0].state,'PUBLISHED');assert.equal(client.submits,2);
 assert.equal((await post(pp,pi)).status,409);assert.equal((await post(gp,gi)).status,409);assert.equal(client.submits,2);
 for(const suffix of ['diagnostics','reconcile','browser-reopen'])assert.equal((await post(`/api/unified/workspaces/${f.w.id}/jobs/${page.id}/${suffix}`,{})).status,423);
 assert.equal((await post(`/api/workspaces/${f.w.id}/proactive/scan`,{account_id:f.account.id})).status,423);
 const health=await (await fetch(origin+'/api/health',{headers:{cookie}})).json();assert.equal(health.executionEnabled,false);assert.equal(health.scanSchedulerEnabled,false);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_daily_claims').get().n,2);assert.equal(f.store.db.prepare("SELECT count(*) n FROM task_action_permits WHERE status='CONSUMED'").get().n,2);
});
test('existing bounded HTTP preparation creates fresh BSK drafts only; independently bound IDs then approve and execute through original paths',async t=>{
 const f=setup(t),{binding,client}=wirePublication(f),asset=join(f.root,'approved-http.png');writeFileSync(asset,Buffer.from([137,80,78,71,13,10,26,10,1]));
 const content=f.publisher.importContent(f.w.id,{source_id:'approved-http-new',revision:'1',title:'Approved HTTP new',body:'Approved complete new HTTP image',media:[asset]}),group=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Explicit allowed',url:'https://www.facebook.com/groups/12345/'}),c=f.store.db.prepare('SELECT * FROM group_content WHERE id=?').get(content.id),payload={title:c.title,body:c.body,tags:[],author:'驻越经营实录'},body_hash=createHash('sha256').update(c.body).digest('hex');let current;
 const mount=async config=>{config.scopeAuthorization.profile_id='bsk:e91ba5d3';config.scopeAuthorization.operations=['PAGE','GROUP'];config.browserSkillBinding=binding;const cloud=cloudFor(f),server=createControlledApp(createApp,f.dbPath,{config,head:'b'.repeat(40),scopeDigest,cloud,browserSkillClient:client,library:{roots:[f.root],snapshotRoot:f.root,gptInboxBase:null}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,login=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cloud.user,password:cloud.password}),redirect:'manual'});assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0],state=await (await fetch(origin+'/api/state?workspace='+f.w.id,{headers:{cookie}})).json();return {server,post:(path,input)=>fetch(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-local-token':state.token},body:JSON.stringify(input)}),close:()=>new Promise(r=>server.close(r))};};
 try{
  const {config}=configFor(f,[]);config.preparations=[{kind:'PAGE',content_id:c.id,content_hash:c.content_hash,body_hash,media_hashes:f.scoped.media([asset]),payload},{kind:'GROUP',content_id:c.id,content_hash:c.content_hash,body_hash,media_hashes:f.scoped.media([asset]),groups:[{id:group.id,external_id:group.external_id,url:group.url}]}];current=await mount(config);
  const pageBase=`/api/unified/workspaces/${f.w.id}/jobs`,groupBase=`/api/workspaces/${f.w.id}/group-jobs`;
  let r=await current.post(pageBase,{account_id:f.account.id,content_id:c.id,payload});assert.equal(r.status,201,await r.clone().text());const page=await r.json();assert.equal(page.state,'DRAFT');assert.equal(page.snapshot.transport,'BROWSER_SKILL');
  r=await current.post(groupBase,{account_id:f.account.id,content_ids:[c.id],group_ids:[group.id]});assert.equal(r.status,201,await r.clone().text());const [job]=await r.json();assert.equal(job.state,'PENDING');assert.equal(job.profile_id,'bsk:e91ba5d3');assert.equal(client.starts,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permits').get().n,0);
  assert.equal((await current.post(pageBase+'/'+page.id+'/execute',{confirm:true,scope_hash:'0'.repeat(64)})).status,423);await current.close();current=null;
  const ps=scopeDigest(f.scoped.describeApproval(page.id).scope),gs=scopeDigest(f.scoped.describe('GROUP',job.id).scope),fixed=configFor(f,[{kind:'PAGE',id:page.id,scope_hash:ps,snapshot_hash:page.snapshot_hash},{kind:'GROUP',id:job.id,scope_hash:gs}]).config;current=await mount(fixed);
  r=await current.post(pageBase+'/'+page.id+'/approve',{snapshot_hash:page.snapshot_hash});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'READY');assert.equal(client.starts,0);
  r=await current.post(pageBase+'/'+page.id+'/execute',{confirm:true,scope_hash:ps});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'PUBLISHED');
  r=await current.post(groupBase+'/auto-publish',{job_ids:[job.id],confirm:true,scope_hash:gs,ack_group_rules:true});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).jobs[0].state,'PUBLISHED');assert.equal(client.submits,2);
 }finally{await current?.close();}
});
