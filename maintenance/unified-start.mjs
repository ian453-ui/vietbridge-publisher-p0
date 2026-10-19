import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {loadSpec,loadMaintenanceConfig,verifyDiagnosticBinding} from './scoped-config.mjs';
import {createControlledApp} from './controlled-app.mjs';
const spec=loadSpec(process.env.PUBLISHER_REVIEWED_RELEASE_SPEC,process.env),{head,release_dir:releasePath,database_path:dbPath}=spec;
// Explicit wrapper read: this entry does not delegate to src/unified-server.js.
const config=loadMaintenanceConfig(process.env.PUBLISHER_SCOPED_AUTHORIZATION_FILE,process.env.PUBLISHER_READONLY_DIAGNOSTIC_CONFIG,process.env.PUBLISHER_BROWSER_REOPEN_AUTHORIZATION_FILE,process.env.PUBLISHER_MANUAL_CONTENT_SYNC_AUTHORIZATION_FILE,process.env.PUBLISHER_OPERATING_SETTINGS_SCOPE_FILE,process.env.PUBLISHER_BROWSER_SKILL_BINDING_FILE);
const {createApp}=await import(pathToFileURL(join(releasePath,'src/server.js')));
const {cloudRuntime}=await import(pathToFileURL(join(releasePath,'src/cloud-runtime.js')));
const {BrowserResources}=await import(pathToFileURL(join(releasePath,'src/browser-resources.js')));
const {scopeDigest}=await import(pathToFileURL(join(releasePath,'src/task-action-permit.js')));
const {contentSyncOptions}=await import(pathToFileURL(join(releasePath,'src/content-sync.js')));
const cloud=cloudRuntime();if(cloud?.mode!=='mac-tunnel')throw Error('MAINTENANCE_EXISTING_AUTH_REQUIRED');
const db=new DatabaseSync(dbPath,{readOnly:true});
try{
 if(config.scopeAuthorization){const account=db.prepare('SELECT * FROM facebook_accounts WHERE id=? AND workspace=?').get(config.scopeAuthorization.account_id,config.scopeAuthorization.workspace);
 if(!account||(!config.browserSkillBinding&&account.profile_id!==config.scopeAuthorization.profile_id)||account.operator_actor_id!==config.scopeAuthorization.actor_id||account.target_page_id!==config.scopeAuthorization.target_page_id)throw Error('MAINTENANCE_BOUND_ACCOUNT_PROFILE_REQUIRED');}
 verifyDiagnosticBinding(dbPath,config.diagnostic);
}finally{db.close();}
const release=new BrowserResources(join(dirname(dbPath),'service-locks')).acquire(dbPath,'unified-service',()=>false,{reconcile:true});let server;
try{
 server=createControlledApp(createApp,dbPath,{config,head,scopeDigest,cloud,contentSync:contentSyncOptions(),library:{roots:process.env.CONTENT_ROOTS_JSON?JSON.parse(process.env.CONTENT_ROOTS_JSON):undefined,gptInboxBase:process.env.GPT_INBOX_BASE}});
}catch(error){release();throw error;}
server.on('storage-closed',release);server.on('error',()=>server.close());server.listen(17882,'127.0.0.1',()=>console.log('Publisher '+(config.mode==='READ_ONLY'?'read-only':'scoped')+' maintenance '+head));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
