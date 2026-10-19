import test from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync,chmodSync,symlinkSync} from 'node:fs';import {createHash} from 'node:crypto';import {join} from 'node:path';
import {setup} from './helpers/scoped-fixture.js';import {createApp} from '../src/server.js';
import {scopeDigest} from '../src/task-action-permit.js';import {createControlledApp} from '../maintenance/controlled-app.mjs';
import {loadScopedConfig,loadSpec} from '../maintenance/scoped-config.mjs';
import {configFor,cloudFor} from './helpers/scoped-wrapper-fixture.js';
const head='a'.repeat(40);
async function mount(t,f,config){const cloud=cloudFor(f),server=createControlledApp(createApp,f.dbPath,{config,head,scopeDigest,cloud,library:{roots:[f.root],snapshotRoot:f.root,gptInboxBase:null},drivers:f.executor.drivers});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port,headers={};
 const login=await fetch(origin+'/auth/login',{method:'POST',headers:{...headers,origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cloud.user,password:cloud.password}),redirect:'manual'});assert.equal(login.status,303,await login.clone().text());const cookie=login.headers.get('set-cookie').split(';')[0],state=await (await fetch(origin+'/api/state?workspace='+f.w.id,{headers:{...headers,cookie}})).json();
 return {origin,cloud,cookie,token:state.token,async post(path,input={},overrides={}){return fetch(origin+path,{method:'POST',headers:{...headers,cookie,origin,'content-type':'application/json','x-local-token':state.token,...overrides},body:JSON.stringify(input)});},get:path=>fetch(origin+path,{headers:{...headers,cookie}})};
}
test('exact production composition loads scope itself; auth/CSRF/app tokens and object/queue boundaries retain default deny',async t=>{
 const f=setup(t),j=f.makePage('Wrapper approved Page'),cap=f.executor.executionCapability(f.w.id,j.id),other=f.makePage('Unselected queued Page'),{config}=configFor(f,[{kind:'PAGE',id:j.id,scope_hash:cap.scopeHash}]),m=await mount(t,f,config),execute=`/api/unified/workspaces/${f.w.id}/jobs/${j.id}/execute`;
 assert.equal((await m.get('/scoped-confirmation-ui.js')).status,200);
 assert.equal((await m.get('/api-response.js')).status,200);
 assert.equal((await m.get('/unlisted-module.js')).status,423);
 assert.equal((await m.post(execute,{confirm:true,scope_hash:cap.scopeHash},{cookie:''})).status,401);
 assert.equal((await m.post(execute,{confirm:true,scope_hash:cap.scopeHash},{'x-local-token':'bad'})).status,409);
 const tokenReply=await m.post('/api/access/tokens',{});assert.equal(tokenReply.status,423);
 // Create a disposable token through the app's existing owner, not the wrapper route.
 const {PublisherAccess}=await import('../src/publisher-access.js');
 // Login instance retains its own tokens; a new isolated server sees the persisted app token.
 const f2=setup(t),j2=f2.makePage(),cap2=f2.executor.executionCapability(f2.w.id,j2.id),c2=configFor(f2,[{kind:'PAGE',id:j2.id,scope_hash:cap2.scopeHash}]).config,cloud2=cloudFor(f2),a2=new PublisherAccess(cloud2);a2.persist();const app=a2.createToken({name:'app',password:cloud2.password,workspaces:[f2.w.id],scopes:['jobs:read','jobs:create'],days:1}),m2=await mount(t,f2,c2);assert.equal((await m2.post(`/api/unified/workspaces/${f2.w.id}/jobs/${j2.id}/execute`,{confirm:true,scope_hash:cap2.scopeHash},{authorization:'Bearer '+app.token})).status,403);
 for(const path of [`/api/unified/workspaces/${f.w.id}/jobs/${other.id}/execute`,`/api/unified/workspaces/ws-other/jobs/${j.id}/execute`,`/api/workspaces/${f.w.id}/profiles`,`/api/workspaces/${f.w.id}/proactive/scan`,`/api/workspaces/${f.w.id}/group-jobs/${j.id}/prepare`,`/api/unified/workspaces/${f.w.id}/jobs/${j.id}/reopen`,`/api/workspaces/${f.w.id}/group-jobs`,`/api/unified/workspaces/${f.w.id}/jobs`])assert.equal((await m.post(path,{job_ids:[j.id]})).status,423,path);
 assert.equal((await m.post(`/api/workspaces/${f.w.id}/group-jobs/auto-publish`,{job_ids:[j.id,other.id]})).status,409);
 assert.equal((await m.post(`/api/workspaces/${f.w.id}/accounts/select`,{id:other.account_id+'wrong'})).status,409);
 const result=await m.post(execute,{confirm:true,scope_hash:cap.scopeHash});assert.equal(result.status,200,await result.clone().text());assert.equal((await result.json()).state,'PUBLISHED');assert.equal(f.submissions,1);assert.equal(f.publisher.job(f.w.id,other.id).state,'READY');
 const retry=await m.post(execute,{confirm:true,scope_hash:cap.scopeHash});assert.equal(retry.status,409);assert.equal(f.submissions,1);
});
test('private production config rejects incomplete/corrupt history, wrong mode and symlink; release spec requires exact paths/SHA/flags',t=>{
 const f=setup(t),j=f.makePage(),cap=f.executor.executionCapability(f.w.id,j.id),{config,file}=configFor(f,[{kind:'PAGE',id:j.id,scope_hash:cap.scopeHash}]);
 chmodSync(file,0o644);assert.throws(()=>loadScopedConfig(file),/0600/);chmodSync(file,0o600);const link=join(f.root,'symlink.json');symlinkSync(file,link);assert.throws(()=>loadScopedConfig(link),/0600/);
 writeFileSync(file,JSON.stringify({...config,scopeAuthorization:{...config.scopeAuthorization,additional_history:[]}}));assert.throws(()=>loadScopedConfig(file),/HISTORY_COVERAGE/);
 writeFileSync(file,JSON.stringify(config));writeFileSync(config.scopeAuthorization.additional_history[0].ledger_paths.events[0],'broken-json\n');assert.throws(()=>loadScopedConfig(file));
 const spec={version:1,head,release_dir:'/reviewed/releases/'+head,database_path:'/Users/a1-6/Library/Application Support/VietBridgePublisherUnified/data/publisher-unified.sqlite'},path=join(f.root,'release.json');writeFileSync(path,JSON.stringify(spec),{mode:0o600});const env={PUBLISHER_BUILD_HEAD:head,PUBLISHER_RELEASE_DIR:spec.release_dir,PUBLISHER_DATABASE_PATH:spec.database_path,PUBLISHER_ENABLE_EXECUTION:'0',PUBLISHER_ENABLE_SCAN_SCHEDULER:'0',PUBLISHER_ENABLE_CONTENT_SYNC:'0'};assert.equal(loadSpec(path,env).head,head);assert.throws(()=>loadSpec(path,{...env,PUBLISHER_BUILD_HEAD:'b'.repeat(40)}),/EXACT_RELEASE/);assert.throws(()=>loadSpec(path,{...env,PUBLISHER_ENABLE_EXECUTION:'1'}),/FLAGS/);
});

test('explicit non-platform preparation routes create only frozen Page/group previews, with no execute authority until actual IDs are independently bound',async t=>{
 const f=setup(t),content=f.publisher.importContent(f.w.id,{source_id:'explicit-preparation',revision:'1',title:'Approved new Visa',body:'Approved preparation body',media:[]}),g=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Explicit group',url:'https://www.facebook.com/groups/12345/'}),c=f.store.db.prepare('SELECT * FROM group_content WHERE id=?').get(content.id),body_hash=createHash('sha256').update(c.body).digest('hex'),payload={title:c.title,body:c.body,tags:[],author:'驻越经营实录'};
 const prepared=configFor(f,[]),config={...prepared.config,preparations:[{kind:'PAGE',content_id:c.id,content_hash:c.content_hash,body_hash,media_hashes:[],payload},{kind:'GROUP',content_id:c.id,content_hash:c.content_hash,body_hash,media_hashes:[],groups:[{id:g.id,external_id:g.external_id,url:g.url}]}]},m=await mount(t,f,config),pagePath=`/api/unified/workspaces/${f.w.id}/jobs`,groupPath=`/api/workspaces/${f.w.id}/group-jobs`;
 let result=await m.post(pagePath,{account_id:f.account.id,content_id:c.id,payload:{...payload,body:'unapproved'}});assert.equal(result.status,409);
 result=await m.post(pagePath,{account_id:f.account.id,content_id:c.id,payload});assert.equal(result.status,201,await result.clone().text());const j=await result.json();assert.equal(j.state,'DRAFT');assert.equal((await m.post(pagePath+'/'+j.id+'/execute',{confirm:true,scope_hash:'0'.repeat(64)})).status,423);
 result=await m.post(groupPath,{account_id:f.account.id,content_ids:[c.id],group_ids:[g.id],group_name_include:'',group_name_exclude:''});assert.equal(result.status,201,await result.clone().text());const [groupJob]=await result.json();assert.equal(groupJob.state,'PENDING');assert.equal((await m.post(`/api/workspaces/${f.w.id}/group-jobs/auto-publish`,{job_ids:[groupJob.id],confirm:true,scope_hash:'0'.repeat(64),ack_group_rules:true})).status,409);
 assert.equal((await m.post(groupPath,{account_id:f.account.id,content_ids:[c.id],group_ids:['wrong']})).status,409);assert.equal(f.creates,0);assert.equal(f.submissions,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_action_permits').get().n,0);
});
