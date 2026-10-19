import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,mkdirSync,symlinkSync,statSync,readdirSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {legacyFixture} from './helpers/legacy-connections-fixture.js';
import {previewLegacyConnections,registerLegacyConnections} from '../src/legacy-connections.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
import {FacebookBrowser} from '../src/facebook-browser.js';

const repository=dirname(dirname(fileURLToPath(import.meta.url)));
function command(f,operation,extra={}){
 const preload=join(f.root,'fixture-cli-preload.mjs');
 writeFileSync(preload,"import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>"+JSON.stringify(f.homeDir)+";syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('Fixture forbids external network');};\n");
 const env={...process.env};for(const key of Object.keys(env))if(/^(PUBLISHER_|FB_|GD_|ADMIN_|WECHAT_|XHS_)/.test(key))delete env[key];
 const args={db:f.dbPath,workspace:f.ws.id,legacy_root:f.legacyRoot,confirm_workspace:f.ws.id,...extra};
 return spawnSync(process.execPath,['--import',preload,'scripts/legacy-connections.mjs',operation,...Object.entries(args).map(([k,v])=>k+'='+v)],{cwd:repository,env,encoding:'utf8',timeout:10000});
}
function snapshot(f,{metadata=true}={}){
 const db=f.store.db,tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name).filter(n=>metadata||!['facebook_accounts','execution_profiles','events'].includes(n));
 return {schema:db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(),tables:Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))};
}
function histories(f){
 const db=f.store.db,resources=new BrowserResources(join(f.root,'original-locks')),e=new UnifiedExecutor(f.publisher,{enabled:false,resources,drivers:{},mediaRoots:[f.root],snapshotRoot:join(f.root,'frozen')});
 const dir=join(f.root,'lp-original');mkdirSync(dir);const profile=f.store.saveProfile(f.lp.id,{name:'Original LP',cdp_port:17921,user_data_dir:dir}),account=f.publisher.saveAccount(f.lp.id,{display_name:'Original LP',expected_identity:'Original LP',identity_type:'PAGE',external_id:'123456',operator_actor_id:'123456',target_page_id:'654321',profile_id:profile.id});
 f.store.put('tasks',{id:'old-submitted',workspaceId:f.lp.id,state:'SUBMITTED',body:'Original frozen task'});f.store.put('tasks',{id:'old-unknown',workspaceId:f.lp.id,state:'UNKNOWN',body:'Old uncertainty'});
 db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?)').run('old-attempt','old-submitted',f.lp.id,'old-intent','SUBMITTED');
 const content=f.publisher.importContent(f.lp.id,{source_id:'old-content',revision:'original',body:'Original complete public body',media:[]}),job=f.publisher.createPageJob(f.lp.id,{account_id:account.id,content_id:content.id});db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(job.id);
 db.prepare("INSERT INTO publisher_execution_permits(id,job_id,scope_json,authorization_json,status,issued_at,expires_at,consumed_at,attempt_id) VALUES(?,?,?,?,'CONSUMED',1,1000,2,?)").run('old-consumed',job.id,'{"fixture":true}','{"old":true}','old-attempt');
 db.prepare("INSERT INTO publisher_execution_permit_events(permit_id,event,detail_json,created_at) VALUES(?,'CONSUMED','{}',2)").run('old-consumed');
 db.prepare("INSERT INTO group_jobs(id,workspace,account_id,group_id,content_id,expected_identity,profile_id,state,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PROCESSING','{}',?,?)").run('old-processing',f.lp.id,account.id,'old-group',content.id,'Original LP',profile.id,'old-time','old-time');
 db.prepare("INSERT INTO engagement_candidates VALUES(?,?,?,?,?,?,'SUBMITTING',?,?,?,?)").run('old-candidate',f.lp.id,account.id,'old-comment','Fixture','LOW','Old reason','Original draft','old-time','old-time');
 db.prepare("INSERT INTO engagement_actions VALUES(?,?,?,?,?,?,'ATTEMPTING',?,?,?,?,?,?)").run('old-action',f.lp.id,account.id,'old-group','old-post','LIKE',null,'old-attempt','{}',null,'old-time','old-time');
 db.prepare('DELETE FROM proactive_settings').run();e.acquireResources(job.snapshot)();
 const lease=join(resources.directory,readdirSync(resources.directory)[0],'owner.json');return {lease,bytes:readFileSync(lease)};
}
function register(f){const p=previewLegacyConnections(f.store.db,f.options);return registerLegacyConnections(f.publisher,{...f.options,confirm_workspace:f.ws.id,preview_hash:p.preview_hash});}

test('real CLI rejected rollback and stale/wrong-customer register never recover history or add defaults',t=>{
 const f=legacyFixture(t),lease=histories(f),before=snapshot(f),p=previewLegacyConnections(f.store.db,f.options);
 for(const [operation,args] of [['rollback',{migration_id:'missing-receipt',rows_hash:'invalid'}],['register',{preview_hash:p.preview_hash,confirm_workspace:f.lp.id}],['register',{preview_hash:'stale-preview'}]]){
  const result=command(f,operation,args);assert.notEqual(result.status,0,result.stdout);assert.deepEqual(snapshot(f),before);assert.deepEqual(readFileSync(lease.lease),lease.bytes);assert.equal(f.store.db.prepare('SELECT count(*) n FROM proactive_settings').get().n,0);
 }
});

test('real CLI register/idempotent repeat/unused rollback change only authorized rows and audit, with no initialization',t=>{
 const f=legacyFixture(t),lease=histories(f),protectedBefore=snapshot(f,{metadata:false}),oldAccounts=f.store.db.prepare('SELECT * FROM facebook_accounts').all(),oldProfiles=f.store.db.prepare('SELECT * FROM execution_profiles').all(),oldEvents=f.store.db.prepare('SELECT * FROM events').all();
 const preview=command(f,'preview');assert.equal(preview.status,0,preview.stderr);const p=JSON.parse(preview.stdout),first=command(f,'register',{preview_hash:p.preview_hash});assert.equal(first.status,0,first.stderr);const receipt=JSON.parse(first.stdout);
 assert.equal(receipt.account_ids.length,2);assert.equal(receipt.profile_ids.length,1);assert.deepEqual(snapshot(f,{metadata:false}),protectedBefore);assert.deepEqual(readFileSync(lease.lease),lease.bytes);
 const after=snapshot(f),repeat=command(f,'register',{preview_hash:p.preview_hash});assert.equal(repeat.status,0,repeat.stderr);assert.equal(JSON.parse(repeat.stdout).already_applied,true);assert.deepEqual(snapshot(f),after);
 const rollback=command(f,'rollback',{migration_id:receipt.migration_id,rows_hash:receipt.rows_hash});assert.equal(rollback.status,0,rollback.stderr);assert.equal(JSON.parse(rollback.stdout).rolled_back,true);assert.deepEqual(snapshot(f,{metadata:false}),protectedBefore);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM facebook_accounts').all(),oldAccounts);assert.deepEqual(f.store.db.prepare('SELECT * FROM execution_profiles').all(),oldProfiles);assert.deepEqual(f.store.db.prepare('SELECT * FROM events ORDER BY seq LIMIT ?').all(oldEvents.length),oldEvents);assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n,oldEvents.length+2);assert.deepEqual(readFileSync(lease.lease),lease.bytes);assert.equal(statSync(f.channelDir).isDirectory(),true);
});

test('real CLI late register failure rolls back both account/profile inserts and does not initialize unrelated data',t=>{
 const f=legacyFixture(t),lease=histories(f);f.store.db.exec("CREATE TRIGGER reject_registration BEFORE INSERT ON events WHEN NEW.event='legacy_connections_registered' BEGIN SELECT RAISE(ABORT,'fixture late register failure'); END");
 const p=previewLegacyConnections(f.store.db,f.options),before=snapshot(f),result=command(f,'register',{preview_hash:p.preview_hash});assert.notEqual(result.status,0);assert.match(result.stderr,/fixture late register failure/);assert.deepEqual(snapshot(f),before);assert.deepEqual(readFileSync(lease.lease),lease.bytes);
});

test('real CLI late rollback failure restores removed metadata and preserves all historical states',t=>{
 const f=legacyFixture(t),lease=histories(f),p=previewLegacyConnections(f.store.db,f.options),first=command(f,'register',{preview_hash:p.preview_hash});assert.equal(first.status,0,first.stderr);const receipt=JSON.parse(first.stdout);
 f.store.db.exec("CREATE TRIGGER reject_rollback BEFORE INSERT ON events WHEN NEW.event='legacy_connections_rolled_back' BEGIN SELECT RAISE(ABORT,'fixture late rollback failure'); END");
 const before=snapshot(f),result=command(f,'rollback',{migration_id:receipt.migration_id,rows_hash:receipt.rows_hash});assert.notEqual(result.status,0);assert.match(result.stderr,/fixture late rollback failure/);assert.deepEqual(snapshot(f),before);assert.deepEqual(readFileSync(lease.lease),lease.bytes);
});

for(const aliasType of ['symlink','uppercase','trailing slash','dot'])test('after migration, ordinary profile creation rejects the same Channels entity via '+aliasType,t=>{
 const f=legacyFixture(t),lease=histories(f);register(f);let alias;
 if(aliasType==='symlink'){alias=join(f.root,'channel-alias');symlinkSync(f.channelDir,alias);}else if(aliasType==='uppercase'){alias=f.channelDir.replace(/wechat-channels$/,'WECHAT-CHANNELS');try{statSync(alias);}catch{symlinkSync(f.channelDir,alias);}}else alias=aliasType==='dot'?f.channelDir+'/.':f.channelDir+'/';
 const a=statSync(alias,{bigint:true}),b=statSync(f.channelDir,{bigint:true});assert.equal(a.dev,b.dev);assert.equal(a.ino,b.ino);const before=snapshot(f);
 assert.throws(()=>f.store.saveProfile(f.lp.id,{name:'Alias new UUID',cdp_port:19225,user_data_dir:alias}),/视频号原环境/);assert.deepEqual(snapshot(f),before);assert.deepEqual(readFileSync(lease.lease),lease.bytes);
});

test('profile modification and Facebook registration/getter reject alias UUIDs even when injected before validation',async t=>{
 const f=legacyFixture(t),lease=histories(f);register(f);const independent=join(f.root,'independent');mkdirSync(independent);const profile=f.store.saveProfile(f.lp.id,{name:'Independent',cdp_port:19225,user_data_dir:independent}),alias=join(f.root,'channel-alias');symlinkSync(f.channelDir,alias);
 const before=snapshot(f);assert.throws(()=>f.store.saveProfile(f.lp.id,{...profile,user_data_dir:alias}),/视频号原环境/);assert.deepEqual(snapshot(f),before);
 // Simulate a preexisting/stale alias record to verify the independent runtime layer.
 f.store.db.prepare('UPDATE execution_profiles SET user_data_dir=? WHERE id=?').run(alias,profile.id);const stale=snapshot(f),input={display_name:'Fixture FB',expected_identity:'Fixture FB',identity_type:'PAGE',external_id:'123456',operator_actor_id:'123456',target_page_id:'654321',profile_id:profile.id};
 assert.throws(()=>f.publisher.saveAccount(f.lp.id,input),/视频号原环境/);assert.throws(()=>f.store.saveAccount(f.lp.id,input),/视频号原环境/);const fb=new FacebookBrowser(f.store);assert.throws(()=>fb.profile(f.lp.id,profile.id),/视频号原环境/);await assert.rejects(()=>fb.launch(f.lp.id,profile.id),/视频号原环境/);assert.deepEqual(snapshot(f),stale);assert.deepEqual(readFileSync(lease.lease),lease.bytes);
});

test('an independent directory/port remains valid, while a later symlink retarget is blocked at runtime',t=>{
 const f=legacyFixture(t);register(f);const independent=join(f.root,'independent');mkdirSync(independent);const alias=join(f.root,'initial-independent-alias');symlinkSync(independent,alias);const profile=f.store.saveProfile(f.lp.id,{name:'Independent FB',cdp_port:19225,user_data_dir:alias}),account=f.publisher.saveAccount(f.lp.id,{display_name:'Independent FB',expected_identity:'Independent FB',identity_type:'PAGE',external_id:'123456',operator_actor_id:'123456',target_page_id:'654321',profile_id:profile.id}),fb=new FacebookBrowser(f.store);
 assert.equal(fb.profile(f.lp.id,profile.id).id,profile.id);renameSync(alias,alias+'-old');symlinkSync(f.channelDir,alias);const before=snapshot(f);assert.throws(()=>fb.profile(f.lp.id,profile.id),/视频号原环境/);assert.equal(f.publisher.account(f.lp.id,account.id).id,account.id);assert.deepEqual(snapshot(f),before);
});

test('a missing original directory or a broken candidate symlink cannot prove directory independence',t=>{
 const f=legacyFixture(t);register(f);const broken=join(f.root,'broken');symlinkSync(join(f.root,'does-not-exist'),broken);assert.throws(()=>f.store.saveProfile(f.lp.id,{name:'Broken',cdp_port:19225,user_data_dir:broken}),/不可核实/);
 const independent=join(f.root,'independent');mkdirSync(independent);renameSync(f.channelDir,f.channelDir+'-moved');const before=snapshot(f);assert.throws(()=>f.store.saveProfile(f.lp.id,{name:'Unknown original',cdp_port:19225,user_data_dir:independent}),/不可核实/);assert.deepEqual(snapshot(f),before);
});
