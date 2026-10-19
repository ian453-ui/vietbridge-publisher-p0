import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {setup} from './helpers/scoped-fixture.js';
import {cloudFor} from './helpers/scoped-wrapper-fixture.js';
import {createApp} from '../src/server.js';
import {createControlledApp} from '../maintenance/controlled-app.mjs';
import {loadMaintenanceConfig} from '../maintenance/scoped-config.mjs';
import {guardOperatingSettings,validateOperatingSettingsScope,operatingSettingsView} from '../maintenance/operating-settings.mjs';
import {operatingSettingsCanEdit,readOperatingSettingsHeader} from '../src/operating-settings-ui.js';

const scopeFor=f=>({version:1,workspace:f.w.id,account_id:f.account.id,actor_id:f.account.operator_actor_id,target_page_id:f.account.target_page_id,issued_at:Date.now()-1000,expires_at:Date.now()+3600000,max_groups:2,max_daily_actions:3,max_followups:5});
const context=(s,suffix,input,principal={type:'admin'})=>({url:new URL(`/api/workspaces/${s.workspace}/proactive/${suffix}`,'http://127.0.0.1'),input,principal});
test('finite ordinary scope cannot carry execution/profile authority and expired view remains read-only',t=>{
 const f=setup(t),s=scopeFor(f);assert.equal(validateOperatingSettingsScope(s),s);
 for(const patch of [{execute:true},{scopeAuthorization:f.policy},{max_groups:3},{max_daily_actions:5},{expires_at:s.issued_at+28800001}])assert.throws(()=>validateOperatingSettingsScope({...s,...patch}));
 const v=operatingSettingsView(s);assert.equal(v.grantsPlatformExecution,false);assert.equal(operatingSettingsCanEdit(v,s.workspace,s.account_id),true);
 assert.equal(operatingSettingsCanEdit(v,'another',s.account_id),false);assert.equal(operatingSettingsCanEdit({...v,grantsPlatformExecution:true},s.workspace,s.account_id),false);
 assert.equal(operatingSettingsView(s,s.expires_at).available,false);
 assert.equal(readOperatingSettingsHeader({get:()=>encodeURIComponent(JSON.stringify(v))}).accountId,s.account_id);
 assert.equal(readOperatingSettingsHeader({get:()=>'%invalid'}),null);
});
test('ordinary settings require current admin and mapping; cannot change stop guards, mode or exceed task limits',t=>{
 const f=setup(t),s=scopeFor(f),settings={account_id:s.account_id,enabled:true,auto_reply:true,auto_like:false,daily_limit:3,lookback_hours:24,max_posts_per_group:10,max_followups:5,global_enabled:true,account_enabled:true,mode:'LIMITED_AUTO'};
 assert.equal(guardOperatingSettings(context(s,'settings',settings),s,f.dbPath),true);
 for(const input of [{...settings,account_id:'other'},{...settings,mode:'AUTO'},{...settings,daily_limit:4},{...settings,max_posts_per_group:11},{...settings,profile_id:'other'},{...settings,enabled:'false'}])assert.throws(()=>guardOperatingSettings(context(s,'settings',input),s,f.dbPath));
 assert.equal(guardOperatingSettings(context(s,'settings',{...settings,global_enabled:false}),s,f.dbPath),true);
 f.store.db.prepare('UPDATE proactive_settings SET global_enabled=0 WHERE account_id=?').run(f.account.id);
 assert.throws(()=>guardOperatingSettings(context(s,'settings',settings),s,f.dbPath),/CANNOT_OPEN/);
 f.store.db.prepare('UPDATE proactive_settings SET global_enabled=1 WHERE account_id=?').run(f.account.id);
 assert.throws(()=>guardOperatingSettings(context(s,'settings',settings,{type:'app'}),s,f.dbPath),/ADMIN_REQUIRED/);
 assert.throws(()=>guardOperatingSettings(context(s,'settings',settings),s,f.dbPath,{now:()=>s.expires_at}),/WINDOW_EXPIRED/);
 assert.equal(guardOperatingSettings(context(s,'scan',{}),s,f.dbPath),false);
 f.store.db.prepare('UPDATE facebook_accounts SET target_page_id=? WHERE id=?').run('999',f.account.id);
 assert.throws(()=>guardOperatingSettings(context(s,'settings',settings),s,f.dbPath),/MAPPING_CHANGED/);
});
test('bulk group edits are atomic-scope checked and limit resulting enabled joined groups to two',t=>{
 const f=setup(t),s=scopeFor(f);f.store.syncGroups(f.w.id,f.account.id,[{name:'A',url:'https://www.facebook.com/groups/101',external_id:'101'},{name:'B',url:'https://www.facebook.com/groups/102',external_id:'102'},{name:'C',url:'https://www.facebook.com/groups/103',external_id:'103'}]);
 const groups=f.store.db.prepare('SELECT id FROM facebook_groups WHERE account_id=? ORDER BY external_id').all(f.account.id);
 const input={account_id:f.account.id,changes:groups.slice(0,2).map(g=>({group_id:g.id,enabled:true}))};
 assert.equal(guardOperatingSettings(context(s,'groups/toggle-bulk',input),s,f.dbPath),true);
 assert.throws(()=>guardOperatingSettings(context(s,'groups/toggle-bulk',{...input,changes:groups.map(g=>({group_id:g.id,enabled:true}))}),s,f.dbPath),/GROUP_LIMIT_2/);
 f.store.db.prepare("UPDATE facebook_groups SET membership_status='LEFT' WHERE id=?").run(groups[0].id);
 assert.throws(()=>guardOperatingSettings(context(s,'groups/toggle-bulk',input),s,f.dbPath),/JOINED_GROUP_REQUIRED/);
});
test('partial settings saves cannot inherit over-limit legacy values; a complete bounded correction passes',t=>{
 const f=setup(t),s=scopeFor(f),bounded={account_id:f.account.id,daily_limit:3,max_posts_per_group:10,lookback_hours:24,max_followups:5,scan_interval_min:60};
 assert.equal(guardOperatingSettings(context(s,'settings',bounded),s,f.dbPath),true);
 for(const [key,legacy] of Object.entries({daily_limit:5,max_posts_per_group:30,lookback_hours:168,max_followups:6,scan_interval_min:1})){
  f.store.db.prepare(`UPDATE proactive_settings SET ${key}=? WHERE account_id=?`).run(legacy,f.account.id);
  const partial={...bounded,enabled:true};delete partial[key];
  assert.throws(()=>guardOperatingSettings(context(s,'settings',partial),s,f.dbPath),/LIMIT_EXCEEDED/,key);
  assert.equal(guardOperatingSettings(context(s,'settings',bounded),s,f.dbPath),true,key);
  f.store.db.prepare(`UPDATE proactive_settings SET ${key}=? WHERE account_id=?`).run(bounded[key],f.account.id);
 }
});
test('private scope loader validates files and never silently ignores an extra scope in scoped mode',t=>{
 const f=setup(t),s=scopeFor(f),file=join(f.root,'operating.json');writeFileSync(file,JSON.stringify(s),{mode:0o600});
 assert.deepEqual(loadMaintenanceConfig(undefined,undefined,undefined,undefined,file).operatingSettingsScope,s);
 assert.throws(()=>loadMaintenanceConfig('anything',undefined,undefined,undefined,file),/REQUIRES_READ_ONLY/);
 chmodSync(file,0o644);assert.throws(()=>loadMaintenanceConfig(undefined,undefined,undefined,undefined,file),/0600/);
});
test('actual normal auth/CSRF route saves only scoped settings while execution/history stay blocked',async t=>{
 const f=setup(t),s=scopeFor(f),j=f.makePage(),before=f.store.db.prepare('SELECT * FROM publisher_jobs').all(),cloud=cloudFor(f);
 const server=createControlledApp(createApp,f.dbPath,{config:{version:1,mode:'READ_ONLY',operatingSettingsScope:s},head:'a'.repeat(40),cloud,library:{roots:[f.root],gptInboxBase:null},drivers:f.executor.drivers});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.once('storage-closed',r);server.close();}));
 const origin='http://127.0.0.1:'+server.address().port,login=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cloud.user,password:cloud.password}),redirect:'manual'});
 const cookie=login.headers.get('set-cookie').split(';')[0],stateResponse=await fetch(origin+'/api/state?workspace='+f.w.id,{headers:{cookie}}),state=await stateResponse.json();assert.equal(readOperatingSettingsHeader(stateResponse.headers).grantsPlatformExecution,false);
 const post=(path,body,extra={})=>fetch(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-local-token':state.token,...extra},body:JSON.stringify(body)});
 const path=`/api/workspaces/${f.w.id}/proactive/settings`,input={account_id:f.account.id,enabled:true,auto_reply:true,daily_limit:3,max_posts_per_group:10};
 assert.equal((await post(path,input,{cookie:''})).status,401);assert.equal((await post(path,input,{'x-local-token':'bad'})).status,409);
 const saved=await post(path,input);assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json()).daily_limit,3);
 assert.equal((await post(path,{...input,global_enabled:false})).status,200);
 assert.equal((await post(path,{...input,global_enabled:true})).status,409);
 for(const p of [`/api/workspaces/${f.w.id}/proactive/scan`,`/api/unified/workspaces/${f.w.id}/jobs/${j.id}/execute`,`/api/unified/workspaces/${f.w.id}/jobs/${j.id}/reconcile`])assert.equal((await post(p,{})).status,423,p);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs').all(),before);assert.equal(f.creates,0);assert.equal(f.submissions,0);
});
