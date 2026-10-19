import {ContentSyncOnce} from './content-sync-once.mjs';
import {makeGuard,restrict,guardLocalPreparation,validateInteractionFlow} from './scoped-maintenance-policy.mjs';
import {verifyDiagnosticBinding} from './scoped-config.mjs';
import {guardOperatingSettings,validateOperatingSettingsScope,operatingSettingsPaths} from './operating-settings.mjs';
import {guardBrowserSkillScan,browserSkillScanPath} from './browser-skill-policy.mjs';
import {validateBrowserSkillBinding} from '../src/browser-skill-binding.js';
import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
/** Shared production and isolated-test composition. No browser is opened here. */
export function createControlledApp(createApp,dbPath,{config,head,scopeDigest,...options}){
 if(config?.interactionFlow){const groups=validateInteractionFlow(config);if(config.targets?.length)throw Error('BSK_FLOW_OR_EXACT_TARGETS_REQUIRED');config={...config,scopeAuthorization:{...config.scopeAuthorization,approved_group_ids:groups,approved_targets:undefined}};}
 if(config?.browserSkillBinding){validateBrowserSkillBinding(config.browserSkillBinding);const b=config.browserSkillBinding,p=config.scopeAuthorization;if(p&&(p.operations.some(k=>!['PAGE','GROUP','INTERACTION'].includes(k))||p.workspace!==b.workspace||p.account_id!==b.account_id||p.actor_id!==b.actor_id||p.target_page_id!==b.target_page_id||p.profile_id!=='bsk:'+b.browser_instance_id))throw Error('BSK_EXACT_OPERATION_POLICY_REQUIRED');}
 if(config?.manualContentSync&&config.mode!=='READ_ONLY')throw Error('MANUAL_SYNC_REQUIRES_ZERO_SCOPE');
 if(config?.mode==='READ_ONLY'){
  if(options.cloud?.mode!=='mac-tunnel')throw Error('MAINTENANCE_EXISTING_AUTH_REQUIRED');
  if(config.version!==1||Object.keys(config).some(k=>!['version','mode','diagnostic','browserReopen','manualContentSync','operatingSettingsScope','browserSkillBinding'].includes(k)))throw Error('READ_ONLY_CONFIG_HAS_AUTHORITY');
  if(config.operatingSettingsScope)validateOperatingSettingsScope(config.operatingSettingsScope);
  verifyDiagnosticBinding(dbPath,config.diagnostic);
  const diag=config.diagnostic,path=diag?`/api/unified/workspaces/${diag.workspace}/jobs/${diag.job_id}/diagnostics`:null;
  const reopen=config.browserReopen,reopenPath=reopen?`/api/unified/workspaces/${reopen.scope.workspace}/jobs/${reopen.scope.job_id}/browser-reopen`:null;
  let sync;const manual=config.manualContentSync?new ContentSyncOnce(()=>sync,config.manualContentSync,options.cloud.dataDir):null;
  const server=createApp(dbPath,{...options,browserSkillBinding:config.browserSkillBinding,readOnlyDiagnosticScope:diag,browserReopenAuthorization:reopen,unified:true,recoverStartup:false,scopeAuthorization:undefined,onScopedOperations:undefined,executionEnabled:false,scanScheduler:false,contentSync:{...options.contentSync,automatic:false},onContentSync:adapter=>{sync=adapter;if(sync)sync.manualPermission=(workspace,accountId)=>manual?manual.capability(workspace,accountId):{canRun:false,reason:'MAINTENANCE_READ_ONLY'};},runContentSync:(workspace,accountId)=>{if(!manual)throw Error('MAINTENANCE_READ_ONLY');return manual.run(workspace,accountId);},requestGuard:({url,input,principal})=>{
   if(guardLocalPreparation({url,input,principal},workspace=>sync.library.clientRoot(workspace)))return;
   if(guardOperatingSettings({url,input,principal},config.operatingSettingsScope,dbPath))return;
   if(guardBrowserSkillScan({url,input,principal},config.browserSkillBinding,config.operatingSettingsScope,dbPath))return;
   if(manual&&url.pathname==='/api/content-sync/run'){if(principal?.type!=='admin')throw Error('SCOPED_ADMINISTRATOR_REQUIRED');if(url.search)throw Error('MANUAL_SYNC_EXACT_INPUT_REQUIRED');manual.check(input.workspace,input.account_id,input);return;}
   if(url.pathname==='/api/access/logout'){if(principal?.type!=='admin'||Object.keys(input).length)throw Error('MAINTENANCE_LOGOUT_INVALID');return;}
   if(reopenPath&&url.pathname===reopenPath){if(principal?.type!=='admin')throw Error('SCOPED_ADMINISTRATOR_REQUIRED');if(Object.keys(input).sort().join(',')!=='attempt_id,authorization_id,confirm,scope'||input.confirm!==true||input.authorization_id!==reopen.id||input.attempt_id!==reopen.attempt_id||Object.keys(input.scope||{}).length!==Object.keys(reopen.scope).length||Object.keys(reopen.scope).some(k=>input.scope[k]!==reopen.scope[k]))throw Error('BROWSER_REOPEN_EXACT_CONFIRMATION_REQUIRED');return;}
   if(!path||url.pathname!==path)throw Error('MAINTENANCE_READ_ONLY');
   if(principal?.type!=='admin')throw Error('SCOPED_ADMINISTRATOR_REQUIRED');
   if(url.search||Object.keys(input).some(k=>k!=='snapshot_hash')||input.snapshot_hash!==diag.snapshot_hash)throw Error('DIAGNOSTIC_FROZEN_SCOPE_MISMATCH');
   verifyDiagnosticBinding(dbPath,diag);
  }});
  restrict(server,head,{maintenanceMode:'read-only',localPreparation:true,operatingSettingsScope:config.operatingSettingsScope,diagnosticPaths:path?[path]:[],postPaths:new Set([...operatingSettingsPaths(config.operatingSettingsScope),...(config.browserSkillBinding&&config.operatingSettingsScope?[browserSkillScanPath(config.browserSkillBinding)]:[]),...(reopenPath?[reopenPath]:[]),...(manual?['/api/content-sync/run']:[])])});return server;
 }
 let ops;
 const describe=(kind,id,reply,{approvalOnly=false}={})=>{if(!ops)throw Error('MAINTENANCE_ADAPTER_NOT_READY');const d=approvalOnly?ops.describeApproval(id):ops.describe(kind,id,reply),expected=config.browserSkillBinding?'bsk:'+config.browserSkillBinding.browser_instance_id:config.scopeAuthorization.profile_id;if(d.scope.profile_id!==expected)throw Error('MAINTENANCE_PROFILE_CHANGED');return {scopeHash:scopeDigest(d.scope)};};
 const verifyPreparation=(bound,input)=>{
  const p=config.scopeAuthorization,c=ops.db.prepare('SELECT * FROM group_content WHERE workspace=? AND id=?').get(p.workspace,bound.content_id),account=ops.store.account(p.workspace,p.account_id);
  if(!c||c.content_hash!==bound.content_hash||(config.browserSkillBinding?ops.facebook.browserSkill.current().profileId:account.profile_id)!==p.profile_id||account.operator_actor_id!==p.actor_id||account.target_page_id!==p.target_page_id||account.publisher_transport!=='BROWSER'||input.account_id!==p.account_id)throw Error('PREPARATION_FROZEN_CONTENT_OR_ACCOUNT_MISMATCH');
  if(bound.kind==='PAGE'){
   if(Object.keys(input).some(k=>!['account_id','content_id','payload'].includes(k))||input.content_id!==bound.content_id||JSON.stringify(input.payload)!==JSON.stringify(bound.payload))throw Error('PREPARATION_EXACT_PAYLOAD_REQUIRED');
   const variant=ops.publisher.contentVariants(c.id).facebook,media=variant?.media||JSON.parse(c.media_json);
   if(hash(bound.payload.body)!==bound.body_hash||JSON.stringify(ops.media(media))!==JSON.stringify(bound.media_hashes))throw Error('PREPARATION_FROZEN_MEDIA_OR_BODY_CHANGED');
  }else{
   if(Object.keys(input).some(k=>!['account_id','content_ids','group_ids','group_name_include','group_name_exclude'].includes(k))||input.content_ids?.length!==1||input.content_ids[0]!==c.id||input.group_name_include||input.group_name_exclude||JSON.stringify(input.group_ids)!==JSON.stringify(bound.groups.map(g=>g.id)))throw Error('PREPARATION_EXACT_GROUP_SELECTION_REQUIRED');
   if(hash(c.body)!==bound.body_hash||JSON.stringify(ops.media(JSON.parse(c.media_json)))!==JSON.stringify(bound.media_hashes))throw Error('PREPARATION_FROZEN_MEDIA_OR_BODY_CHANGED');
   for(const g of bound.groups){const row=ops.db.prepare('SELECT * FROM facebook_groups WHERE workspace=? AND account_id=? AND id=?').get(p.workspace,p.account_id,g.id);if(!row||row.external_id!==g.external_id||row.url!==g.url||!row.enabled||row.membership_status!=='JOINED')throw Error('PREPARATION_APPROVED_GROUP_CHANGED');}
  }
 };
 const guard=makeGuard(config,{describe,verifyPreparation}),diag=config.diagnostic,diagnosticPath=diag?`/api/unified/workspaces/${diag.workspace}/jobs/${diag.job_id}/diagnostics`:null;
 const server=createApp(dbPath,{...options,browserSkillBinding:config.browserSkillBinding,unified:true,recoverStartup:!config.browserSkillBinding,recoverScopedStartup:Boolean(config.browserSkillBinding),scopeAuthorization:config.scopeAuthorization,executionEnabled:false,scanScheduler:false,contentSync:{...options.contentSync,automatic:false},onContentSync:sync=>{if(sync)sync.manualPermission=()=>({canRun:false,reason:'MAINTENANCE_READ_ONLY'});},requestGuard:context=>{if(guardOperatingSettings(context,config.operatingSettingsScope,dbPath)||guardBrowserSkillScan(context,config.browserSkillBinding,config.operatingSettingsScope,dbPath))return;if(diagnosticPath&&context.url.pathname===diagnosticPath)return;guard.requestGuard(context);},onScopedOperations:adapter=>{
  ops=adapter;for(const t of config.targets){if(!config.scopeAuthorization.operations.includes(t.kind)||describe(t.kind,t.id,t.reply_body,{approvalOnly:t.kind==='PAGE'&&!!t.snapshot_hash&&ops.publisher.job(config.scopeAuthorization.workspace,t.id).state==='DRAFT'}).scopeHash!==t.scope_hash)throw Error('MAINTENANCE_TARGET_SCOPE_MISMATCH');}
  const status=ops.status();if(status.error)throw Error('MAINTENANCE_HISTORY_NOT_VERIFIED:'+status.error);
 }});
 restrict(server,head,{postPaths:new Set([...guard.postPaths,...operatingSettingsPaths(config.operatingSettingsScope),...(config.browserSkillBinding&&config.operatingSettingsScope?[browserSkillScanPath(config.browserSkillBinding)]:[])]),dynamicPostAllowed:guard.dynamicPostAllowed,operatingSettingsScope:config.operatingSettingsScope,diagnosticPaths:diagnosticPath?[diagnosticPath]:[]});return server;
}
