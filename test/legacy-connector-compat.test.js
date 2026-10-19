import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync,readdirSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {legacyFixture} from './helpers/legacy-connections-fixture.js';
import {previewLegacyConnections,registerLegacyConnections,rollbackLegacyConnections} from '../src/legacy-connections.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
import {FacebookBrowser} from '../src/facebook-browser.js';
import {XiaohongshuPublishDriver} from '../src/multiplatform-drivers.js';
import {unifiedPublisherView,unifiedAccountManagerView} from '../src/unified-client.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const schema=db=>digest(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all());
const count=(f,table)=>f.store.db.prepare('SELECT count(*) n FROM '+table).get().n;
const register=f=>{const p=previewLegacyConnections(f.store.db,f.options);return registerLegacyConnections(f.publisher,{...f.options,confirm_workspace:f.ws.id,preview_hash:p.preview_hash});};
const executor=(f,extra={})=>new UnifiedExecutor(f.publisher,{enabled:false,resources:new BrowserResources(join(f.root,'locks')),drivers:{create:async()=>{throw Error('No platform connection allowed');}},mediaRoots:[f.contentRoot],snapshotRoot:join(f.root,'frozen'),...extra});

test('original MCP account needs no Chrome row, freezes its connector and remains disabled for execution',async t=>{
 const f=legacyFixture(t),e=executor(f),before=schema(f.store.db),a=f.xhs(),j=f.job(a);
 assert.equal(a.profile_id,'');assert.equal(f.publisher.context(f.ws.id,a.id).profile,null);assert.equal(count(f,'execution_profiles'),0);
 assert.equal(j.snapshot.profileId,null);assert.equal(j.snapshot.profileDir,null);assert.equal(j.snapshot.cdpPort,null);
 assert.deepEqual(j.snapshot.executionRef,{kind:'MCP',endpoint:'http://127.0.0.1:18060/mcp'});
 assert.doesNotThrow(()=>f.publisher.assertCurrent(j));assert.equal(schema(f.store.db),before);
 await assert.rejects(()=>e.execute(f.ws.id,j.id),/验收模式/);assert.equal(f.publisher.job(f.ws.id,j.id).state,'DRAFT');
 assert.match(unifiedPublisherView(f.ws.id,a,[],[],[a]),/MCP.*18060\/mcp.*无需Chrome环境/);
 assert.doesNotMatch(unifiedAccountManagerView(f.ws.id,[],[a]),/<button disabled>保存平台账号/);
});

test('MCP endpoint aliases cannot cross customers and invalid references fail before any account write',t=>{
 const f=legacyFixture(t),a=f.xhs({publisher_options:{mcp_endpoint:'http://127.0.0.1:18060/a/../mcp'}});
 assert.equal(a.publisher_options.mcp_endpoint,'http://127.0.0.1:18060/mcp');
 assert.throws(()=>f.publisher.saveAccount(f.lp.id,{platform:'xiaohongshu',display_name:'Other',external_id:'username:Other',publisher_options:{mcp_endpoint:'http://127.0.0.1:18060/mcp'}}),/另一客户/);
 for(const endpoint of ['http://remote.example:18060/mcp','http://127.0.0.1:18060/mcp?token=fake','http://fake:fake@127.0.0.1:18060/mcp','http://127.0.0.1:18060/mcp#x'])assert.throws(()=>f.xhs({external_id:'username:bad',publisher_options:{mcp_endpoint:endpoint}}));
 assert.throws(()=>f.xhs({external_id:'username:bad',profile_id:7}),/格式/);assert.equal(count(f,'facebook_accounts'),1);
});

test('a changed connector invalidates approval without rewriting old frozen history',t=>{
 const f=legacyFixture(t),a=f.xhs(),j=f.job(a),before=f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(j.id);
 f.xhs({...a,publisher_options:{mcp_endpoint:'http://127.0.0.1:18061/mcp'}});
 assert.throws(()=>f.publisher.approve(f.ws.id,j.id,j.snapshot_hash),/配置已变化/);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(j.id),before);
 assert.throws(()=>f.publisher.job(f.lp.id,j.id),/不属于/);
});

test('existing real-profile XHS snapshots retain their environment and cross-customer profile references fail',t=>{
 const f=legacyFixture(t),p=f.store.saveProfile(f.ws.id,{name:'Old XHS',cdp_port:19444,user_data_dir:join(f.root,'old-xhs')}),a=f.xhs({profile_id:p.id}),j=f.job(a),before=JSON.stringify(j.snapshot);
 const {profile_id,...input}=a;f.xhs(input);assert.equal(f.publisher.account(f.ws.id,a.id).profile_id,p.id);
 assert.equal(JSON.stringify(f.publisher.job(f.ws.id,j.id).snapshot),before);assert.equal(j.snapshot.executionRef,undefined);assert.doesNotThrow(()=>f.publisher.assertCurrent(j));
 const foreign=f.store.saveProfile(f.lp.id,{name:'Foreign',cdp_port:19445,user_data_dir:join(f.root,'foreign')});
 assert.throws(()=>f.xhs({...a,profile_id:foreign.id}),/不属于/);
});

test('UNKNOWN canonical, absent and malformed MCP references block fresh claims and leave permits/history unchanged',t=>{
 const f=legacyFixture(t),a=f.xhs(),old=f.job(a),fresh=f.job(a,{body:'Different fresh fixture body'}),e=executor(f,{enabled:true});e.approve(f.ws.id,fresh.id,fresh.snapshot_hash);
 for(const endpoint of ['http://127.0.0.1:18060/a/../mcp',null,'not-a-url','http://remote.example:18060/mcp','http://127.0.0.1:18060/mcp?token=fake']){
  const snapshot={...old.snapshot,options:{mcp_endpoint:endpoint}};
  f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot),old.id);
  const before=f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id),permits=digest(f.store.db.prepare('SELECT * FROM publisher_execution_permits').all());
  assert.throws(()=>e.claim(f.ws.id,fresh.id),/MCP连接/);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(old.id),before);assert.equal(digest(f.store.db.prepare('SELECT * FROM publisher_execution_permits').all()),permits);assert.equal(f.publisher.job(f.ws.id,fresh.id).state,'READY');
 }
});

test('pure MCP takes one shared sidecar lease and UNKNOWN retains it across a second executor and read-only reconciliation',t=>{
 const f=legacyFixture(t),a=f.xhs(),j=f.job(a),resources=new BrowserResources(join(f.root,'locks')),e=executor(f,{resources}),other=executor(f);
 const release=e.acquireResources(j.snapshot);assert.equal(resources.active.size,1);assert.throws(()=>other.acquireResources(j.snapshot),/RECONCILIATION_REQUIRED/);
 f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(j.id);release();
 const leasePath=join(resources.directory,readdirSync(resources.directory)[0],'owner.json'),before=readFileSync(leasePath,'utf8');assert.equal(JSON.parse(before).phase,'PENDING');
 const readRelease=other.acquireResources(j.snapshot,{reconcile:true});readRelease();assert.equal(readFileSync(leasePath,'utf8'),before);assert.equal(count(f,'execution_profiles'),0);
});

test('actual XHS identity remains mandatory before preflight or submit despite metadata compatibility',async t=>{
 const f=legacyFixture(t),a=f.xhs(),j=f.job(a);let identity='username:wrong',writes=0,reads=0;
 const client={loginStatus:async()=>({loggedIn:true,accountId:identity}),readbackHealth:async()=>{reads++;return {ok:true};},findPublished:async()=>({status:'none'}),publishImages:async()=>{writes++;return {text:'note_id: fixture'};},close:async()=>{}};
 const driver=new XiaohongshuPublishDriver(j.snapshot,{client});await assert.rejects(()=>driver.inspect(),/身份不匹配/);await assert.rejects(()=>driver.prepare(j.snapshot,[f.image]),/身份不匹配/);await assert.rejects(()=>driver.submit(),/身份不匹配/);assert.equal(reads,0);assert.equal(writes,0);
 const e=executor(f,{drivers:{create:async snapshot=>{assert.equal(snapshot.profileId,null);assert.equal(snapshot.executionRef.endpoint,'http://127.0.0.1:18060/mcp');return new XiaohongshuPublishDriver(snapshot,{client});}}});await assert.rejects(()=>e.inspectAccount(f.ws.id,a.id),/身份不匹配/);assert.equal(e.resources.active.size,0);
 identity=a.external_id;assert.equal((await e.inspectAccount(f.ws.id,a.id)).healthy,true);assert.equal(e.resources.active.size,0);assert.equal((await driver.inspect()).healthy,true);await driver.prepare(j.snapshot,[f.image]);identity='username:switched';await assert.rejects(()=>driver.submit(),/身份不匹配/);assert.equal(writes,0);
});

test('registration is idempotent metadata only, keeps original video directory/port and adds no permission',t=>{
 const f=legacyFixture(t);executor(f);const beforeSchema=schema(f.store.db),dir=statSync(f.channelDir),source=readFileSync(join(f.legacyRoot,'data/publisher.sqlite'));
 const protectedTables=['publisher_jobs','publisher_execution_permits','publisher_browser_locks','group_jobs','attempts'],before=protectedTables.map(table=>digest(f.store.db.prepare('SELECT * FROM '+table).all()));
 const first=register(f),second=register(f);assert.equal(first.already_applied,false);assert.equal(second.already_applied,true);assert.deepEqual(first.accounts.map(a=>a.id),second.accounts.map(a=>a.id));assert.equal(count(f,'facebook_accounts'),2);assert.equal(count(f,'execution_profiles'),1);
 const channel=f.publisher.accountsView(f.ws.id).publisherAccounts.find(a=>a.platform==='wechat_channels'),profile=f.publisher.context(f.ws.id,channel.id).profile;
 assert.equal(profile.user_data_dir,f.channelDir);assert.equal(profile.cdp_port,19224);assert.equal(profile.status,'STOPPED');assert.equal(channel.session_health,'UNKNOWN');assert.equal(channel.publisher_options.profile_identity_confirmed,false);
 assert.deepEqual([statSync(f.channelDir).dev,statSync(f.channelDir).ino,statSync(f.channelDir).mode],[dir.dev,dir.ino,dir.mode]);assert.deepEqual(readFileSync(join(f.legacyRoot,'data/publisher.sqlite')),source);
 assert.equal(schema(f.store.db),beforeSchema);assert.deepEqual(protectedTables.map(table=>digest(f.store.db.prepare('SELECT * FROM '+table).all())),before);assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE event='legacy_connections_registered'").get().n,1);
 assert.equal(first.metadata_only,true);assert.equal(previewLegacyConnections(f.store.db,f.options).live_identity_verified,false);assert.deepEqual(Object.keys(previewLegacyConnections(f.store.db,f.options).blocked).sort(),['facebook','wechat_official_account']);
});

test('migration refuses LP, shared-root ownership, stale preview and changed public identity source without partial writes',t=>{
 const f=legacyFixture(t),preview=previewLegacyConnections(f.store.db,f.options);
 assert.throws(()=>previewLegacyConnections(f.store.db,{...f.options,workspace:f.lp.id}),/其他客户/);
 assert.throws(()=>registerLegacyConnections(f.publisher,{...f.options,confirm_workspace:f.lp.id,preview_hash:preview.preview_hash}),/明确确认/);
 writeFileSync(join(f.legacyRoot,'src/task-service.ts'),readFileSync(join(f.legacyRoot,'src/task-service.ts'),'utf8').replace('Fixture XHS','Changed XHS'));
 assert.throws(()=>registerLegacyConnections(f.publisher,{...f.options,confirm_workspace:f.ws.id,preview_hash:preview.preview_hash}),/预览已变化/);assert.equal(count(f,'facebook_accounts'),0);assert.equal(count(f,'execution_profiles'),0);
 f.store.saveWorkspace({name:'Shared',library_kind:'enterprise',content_root:f.contentRoot});assert.throws(()=>previewLegacyConnections(f.store.db,f.options),/归属不唯一/);
});

test('physical directory aliases, foreign port and disabled conflicting identities stop the entire migration',t=>{
 const f=legacyFixture(t),alias=join(f.root,'channel-alias');symlinkSync(f.channelDir,alias);
 f.store.saveProfile(f.lp.id,{name:'Foreign alias',cdp_port:19225,user_data_dir:alias});const preview=previewLegacyConnections(f.store.db,f.options);
 assert.equal(preview.plans.find(p=>p.platform==='wechat_channels').status,'BLOCKED');assert.throws(()=>register(f),/阻断/);assert.equal(count(f,'facebook_accounts'),0);
 f.xhs({enabled:false});assert.equal(previewLegacyConnections(f.store.db,f.options).plans.find(p=>p.platform==='xiaohongshu').status,'BLOCKED');assert.throws(()=>register(f),/阻断/);assert.equal(count(f,'facebook_accounts'),1);
});

test('missing directory or old READY proof cannot invent a usable original browser environment',t=>{
 const f=legacyFixture(t);const changed={...f.options,homeDir:join(f.root,'missing-home')};
 const preview=previewLegacyConnections(f.store.db,changed);assert.equal(preview.plans.find(p=>p.platform==='wechat_channels').status,'BLOCKED');assert.throws(()=>registerLegacyConnections(f.publisher,{...changed,confirm_workspace:f.ws.id,preview_hash:preview.preview_hash}),/阻断/);assert.equal(count(f,'facebook_accounts'),0);
});

test('a later wrong-account observation overrides an earlier READY record for the original channel',t=>{
 const f=legacyFixture(t),db=new DatabaseSync(join(f.legacyRoot,'data/publisher.sqlite'));
 db.prepare('INSERT INTO profile_health VALUES(?,?,?,?)').run('wechat-channels-managed-v1','sph-wrong-account','2026-10-12T00:00:00.000Z','READY');db.close();
 const plan=previewLegacyConnections(f.store.db,f.options);assert.equal(plan.plans.find(p=>p.platform==='wechat_channels').status,'BLOCKED');assert.throws(()=>register(f),/阻断/);assert.equal(count(f,'facebook_accounts'),0);
});

test('a foreign 19224 registration or a different channel on the same physical profile cannot be adopted',t=>{
 const f=legacyFixture(t),p=f.store.saveProfile(f.ws.id,{name:'Original path',cdp_port:19224,user_data_dir:f.channelDir});
 f.publisher.saveAccount(f.ws.id,{platform:'wechat_channels',display_name:'Wrong Channel',expected_identity:'Wrong Channel',external_id:'sph-other-channel',profile_id:p.id});
 assert.equal(previewLegacyConnections(f.store.db,f.options).plans.find(p=>p.platform==='wechat_channels').status,'BLOCKED');assert.throws(()=>register(f),/阻断/);
 assert.throws(()=>f.publisher.saveAccount(f.ws.id,{platform:'wechat_channels',display_name:'Another',external_id:'sph-another',profile_id:p.id}),/其他账号/);assert.equal(count(f,'facebook_accounts'),1);
});

test('a different customer owning the original fixed 19224 port blocks migration even with another directory',t=>{
 const f=legacyFixture(t);f.store.saveProfile(f.lp.id,{name:'Foreign port',cdp_port:19224,user_data_dir:join(f.root,'foreign-channel')});
 assert.equal(previewLegacyConnections(f.store.db,f.options).plans.find(p=>p.platform==='wechat_channels').status,'BLOCKED');assert.throws(()=>register(f),/阻断/);assert.equal(count(f,'facebook_accounts'),0);
});

test('registration preserves populated LP UNKNOWN and PUBLISHED jobs, consumed permit and pending browser lease byte for byte',t=>{
 const f=legacyFixture(t),e=executor(f),lpDir=join(f.root,'lp-original');mkdirSync(lpDir,{mode:0o700});const p=f.store.saveProfile(f.lp.id,{name:'LP original',cdp_port:17921,user_data_dir:lpDir}),a=f.publisher.saveAccount(f.lp.id,{display_name:'Fixture LP Page',identity_type:'PAGE',external_id:'123',operator_actor_id:'123',target_page_id:'456',profile_id:p.id});
 for(const [id,state] of [['old-009','UNKNOWN'],['old-021','PUBLISHED']]){const c=f.publisher.importContent(f.lp.id,{source_id:id,revision:'original',title:id,body:'Original '+id,media:[]}),j=f.publisher.createPageJob(f.lp.id,{account_id:a.id,content_id:c.id});f.store.db.prepare('UPDATE publisher_jobs SET state=? WHERE id=?').run(state,j.id);if(state==='UNKNOWN'){
  f.store.db.prepare("INSERT INTO publisher_execution_permits(id,job_id,scope_json,authorization_json,status,issued_at,expires_at,consumed_at,attempt_id) VALUES(?,?,?,?,'CONSUMED',1,1000,2,?)").run('old-consumed',j.id,'{"fixture":true}','{"old":true}','old-attempt');
  f.store.db.prepare("INSERT INTO publisher_execution_permit_events(permit_id,event,detail_json,created_at) VALUES(?,'CONSUMED','{}',2)").run('old-consumed');e.acquireResources(j.snapshot)();
 }}
 const tables=['publisher_jobs','publisher_execution_permits','publisher_execution_permit_events','publisher_browser_locks','attempts','group_content'],before=tables.map(table=>digest(f.store.db.prepare('SELECT * FROM '+table).all())),lease=join(e.resources.directory,readdirSync(e.resources.directory)[0],'owner.json'),bytes=readFileSync(lease);
 register(f);assert.deepEqual(tables.map(table=>digest(f.store.db.prepare('SELECT * FROM '+table).all())),before);assert.deepEqual(readFileSync(lease),bytes);assert.equal(f.publisher.accountsView(f.lp.id).publisherAccounts.length,1);assert.equal(f.publisher.accountsView(f.ws.id).publisherAccounts.length,2);
});

test('unused rollback removes only inserted rows, preserves original files and audit, and cannot auto-resurrect',t=>{
 const f=legacyFixture(t),receipt=register(f),dir=statSync(f.channelDir);
 const result=rollbackLegacyConnections(f.publisher,{workspace:f.ws.id,confirm_workspace:f.ws.id,migration_id:receipt.migration_id,rows_hash:receipt.rows_hash});assert.equal(result.rolled_back,true);assert.equal(count(f,'facebook_accounts'),0);assert.equal(count(f,'execution_profiles'),0);assert.equal(statSync(f.channelDir).ino,dir.ino);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE event='legacy_connections_rolled_back'").get().n,1);assert.throws(()=>register(f),/不会自动修复/);
});

test('rollback refuses changed rows and any selected or used account without deleting history',t=>{
 const f=legacyFixture(t),receipt=register(f),a=f.publisher.accountsView(f.ws.id).publisherAccounts.find(a=>a.platform==='xiaohongshu'),opts={workspace:f.ws.id,confirm_workspace:f.ws.id,migration_id:receipt.migration_id,rows_hash:receipt.rows_hash};
 f.publisher.selectAccount(f.ws.id,a.id);assert.throws(()=>rollbackLegacyConnections(f.publisher,opts),/已被选择/);f.store.db.prepare('DELETE FROM workspace_preferences WHERE workspace=?').run(f.ws.id);
 const j=f.job(a);f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(j.id);const before=f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(j.id);assert.throws(()=>rollbackLegacyConnections(f.publisher,opts),/已被业务使用/);assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(j.id),before);
 f.store.db.prepare("UPDATE facebook_accounts SET display_name='changed' WHERE id=?").run(a.id);assert.throws(()=>rollbackLegacyConnections(f.publisher,opts),/登记已变化/);assert.equal(count(f,'facebook_accounts'),2);assert.equal(count(f,'execution_profiles'),1);
});

test('rollback refuses an existing quota reservation without needing a publication job',t=>{
 const f=legacyFixture(t),receipt=register(f),a=receipt.accounts[0];
 f.store.db.prepare('INSERT INTO interaction_budget VALUES(?,?,?,?,?,?,?,?,?,?)').run('existing-quota',f.ws.id,a.id,null,null,'fixture-target','LIKE','old-owner','RESERVED','2026-10-12T00:00:00Z');
 const before=f.store.db.prepare('SELECT * FROM interaction_budget').all();assert.throws(()=>rollbackLegacyConnections(f.publisher,{workspace:f.ws.id,confirm_workspace:f.ws.id,migration_id:receipt.migration_id,rows_hash:receipt.rows_hash}),/已被业务使用/);assert.deepEqual(f.store.db.prepare('SELECT * FROM interaction_budget').all(),before);assert.equal(count(f,'facebook_accounts'),2);
});

test('original video environment cannot be registered or launched as Facebook',async t=>{
 const f=legacyFixture(t);register(f);const channel=f.publisher.accountsView(f.ws.id).publisherAccounts.find(a=>a.platform==='wechat_channels');
 assert.throws(()=>f.publisher.saveAccount(f.ws.id,{display_name:'Wrong FB',identity_type:'PAGE',external_id:'123',operator_actor_id:'123',target_page_id:'456',profile_id:channel.profile_id}),/视频号原环境/);
 const fb=new FacebookBrowser(f.store);assert.throws(()=>fb.profile(f.ws.id,channel.profile_id),/不能用于Facebook/);await assert.rejects(()=>fb.launch(f.ws.id,channel.profile_id),/不能用于Facebook/);
 assert.equal(count(f,'facebook_accounts'),2);assert.equal(f.publisher.context(f.ws.id,channel.id).profile.status,'STOPPED');
});
