import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {createControlledApp} from '../maintenance/controlled-app.mjs';

// Execute the actual production entry and actual controlled-app composition.
// Only imports with external effects are replaced by isolated fixture modules:
// no production database, credential, Drive client, browser, socket or lock.
async function bootFixture(mode) {
  const head='a'.repeat(40),scopeHash='b'.repeat(64);
  const sources=[{projectId:'LP-FIXTURE',workspaceId:'ws-fixture',relativeRoot:'clients/lp-fixture',manifestDriveFileId:'fixture-manifest'}];
  let resolverCalls=0,connectorCalls=0,appOptions,listenCalls=0;
  const makeClient=async()=>{connectorCalls++;throw Error('REAL_CONNECTOR_FORBIDDEN');};
  const env={PUBLISHER_ENABLE_CONTENT_SYNC:'0',PUBLISHER_MANIFEST_SOURCES_FILE:'/fixture/sources.json',PUBLISHER_DRIVE_CONNECTOR_ENTRY:'/fixture/existing-connector.js'};
  const account={profile_id:'fixture-profile',operator_actor_id:'123',target_page_id:'456'};
  const config=mode==='READ_ONLY'?{version:1,mode}:{version:1,scopeAuthorization:{workspace:'ws-fixture',account_id:'fixture-account',actor_id:'123',target_page_id:'456',profile_id:'fixture-profile',expires_at:Date.now()+60000,operations:['PAGE']},targets:[{kind:'PAGE',id:'fixture-job',scope_hash:scopeHash}]};
  const server=new EventEmitter();
  server.listen=(port,host,ready)=>{assert.equal(port,17882);assert.equal(host,'127.0.0.1');listenCalls++;ready();return server;};
  server.close=()=>{};
  const createApp=(_db,options)=>{
    appOptions=options;
    options.onScopedOperations?.({describe:()=>({scope:{profile_id:account.profile_id}}),status:()=>({pending:false})});
    return server;
  };
  const spec={head,release_dir:'/fixture/release',database_path:'/fixture/isolated.sqlite'};
  class FixtureDatabase {prepare(){return {get:()=>account};}close(){}}
  class FixtureResources {acquire(){return ()=>{};}}
  const modules={
    'node:path':{join,dirname},'node:url':{pathToFileURL},'node:sqlite':{DatabaseSync:FixtureDatabase},
    './scoped-config.mjs':{loadSpec:()=>spec,loadMaintenanceConfig:()=>config,verifyDiagnosticBinding:()=>{}},
    './controlled-app.mjs':{createControlledApp},
    'file:///fixture/release/src/server.js':{createApp},
    'file:///fixture/release/src/cloud-runtime.js':{cloudRuntime:()=>({mode:'mac-tunnel'})},
    'file:///fixture/release/src/browser-resources.js':{BrowserResources:FixtureResources},
    'file:///fixture/release/src/task-action-permit.js':{scopeDigest:()=>scopeHash},
    'file:///fixture/release/src/content-sync.js':{contentSyncOptions:()=>{resolverCalls++;return {sources,makeClient,automatic:true};}}
  };
  const entry=readFileSync(new URL('../maintenance/unified-start.mjs',import.meta.url),'utf8');
  const isolated=entry.replace(/^import (\{[^}]+\}) from '([^']+)';$/gm,'const $1=await fixtureImport("$2");').replace(/await import\(/g,'await fixtureImport(');
  const context={process:{env,once:()=>{}},console:{log:()=>{}},fixtureImport:async key=>{
    if(!Object.hasOwn(modules,key))throw Error('UNEXPECTED_FIXTURE_IMPORT:'+key);
    return modules[key];
  }};
  await new vm.Script('(async()=>{'+isolated+'})()',{filename:'actual-maintenance-entry-fixture'}).runInNewContext(context);
  assert.equal(resolverCalls,1,'production entry must load the existing registered-source resolver');
  assert.equal(appOptions.contentSync.sources,sources,'controlled wrapper must retain exact registered source bindings');
  assert.equal(appOptions.contentSync.makeClient,makeClient,'controlled wrapper must retain the lazy existing connector factory');
  assert.equal(appOptions.contentSync.automatic,false,'maintenance must override automatic=true and preserve zero synchronization authority');
  assert.equal(appOptions.executionEnabled,false);
  assert.equal(appOptions.scanScheduler,false);
  assert.equal(appOptions.recoverStartup,mode!=='READ_ONLY');
  assert.equal(connectorCalls,0,'boot must never invoke a connector or read its credentials');
  assert.equal(listenCalls,1);
}

test('actual read-only maintenance boot preserves registered source and lazy connector without starting synchronization',()=>bootFixture('READ_ONLY'));
test('actual scoped maintenance boot preserves registered source and lazy connector without global execution or synchronization',()=>bootFixture('SCOPED'));
