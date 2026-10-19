import {isAbsolute} from 'node:path';
import {lstatSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {parse} from 'yaml';
import {validateOperatingSettingsScope} from './operating-settings.mjs';
import {validateBrowserSkillBinding} from '../src/browser-skill-binding.js';
import {validateInteractionFlow} from './scoped-maintenance-policy.mjs';
const fail=m=>{throw Error(m);};
const privateJSON=path=>{if(!isAbsolute(path||''))fail('ABSOLUTE_PRIVATE_CONFIG_REQUIRED');const s=lstatSync(path);if(!s.isFile()||(s.mode&0o777)!==0o600)fail('REGULAR_0600_CONFIG_REQUIRED');return JSON.parse(readFileSync(path,'utf8'));};
export function loadPageHistoryConfig(path){
 const data=privateJSON(path),sources=data.additional_history;
 if(data.version!==1||!Array.isArray(sources)||!sources.some(s=>s.kind==='V1'))fail('PRODUCTION_LEGACY_HISTORY_COVERAGE_REQUIRED');
 for(const source of sources){
  if(!isAbsolute(source.path||'')||!['V1','UNIFIED'].includes(source.kind))fail('COMPLETE_READONLY_HISTORY_REQUIRED');
  const db=new DatabaseSync(source.path,{readOnly:true});try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),required=source.kind==='V1'?['jobs','facebook_accounts','platform_attempts','platform_receipts','content_snapshots']:['publisher_jobs','facebook_accounts'];if(required.some(t=>!tables.includes(t)))fail('HISTORY_SCHEMA_REQUIRED');}finally{db.close();}
  if(source.kind==='V1'){const paths=source.ledger_paths;if(!Array.isArray(paths?.events)||paths.events.length<2||new Set(paths.events).size!==paths.events.length||!isAbsolute(paths.yaml||''))fail('COMPLETE_V1_LEDGER_PATHS_REQUIRED');for(const file of paths.events){if(!isAbsolute(file))fail('COMPLETE_READONLY_HISTORY_REQUIRED');for(const line of readFileSync(file,'utf8').split(/\r?\n/))if(line.trim())JSON.parse(line);}const doc=parse(readFileSync(paths.yaml,'utf8'),{uniqueKeys:false});if(!doc?.published_history||typeof doc.published_history!=='object'||Array.isArray(doc.published_history))fail('LEDGER_HISTORY_SHAPE_REQUIRED');}
 }
 return sources;
}
export function loadSpec(path,env){const spec=privateJSON(path);if(spec.version!==1||!/^[a-f0-9]{40}$/.test(spec.head||'')||env.PUBLISHER_BUILD_HEAD!==spec.head||env.PUBLISHER_RELEASE_DIR!==spec.release_dir||!spec.release_dir?.endsWith('/'+spec.head)||env.PUBLISHER_DATABASE_PATH!==spec.database_path||spec.database_path!=='/Users/a1-6/Library/Application Support/VietBridgePublisherUnified/data/publisher-unified.sqlite')fail('MAINTENANCE_EXACT_RELEASE_REQUIRED');for(const flag of ['PUBLISHER_ENABLE_EXECUTION','PUBLISHER_ENABLE_SCAN_SCHEDULER','PUBLISHER_ENABLE_CONTENT_SYNC'])if(env[flag]!=='0')fail('MAINTENANCE_FLAGS_REQUIRED');return spec;}
export function loadScopedConfig(path,{now=()=>Date.now(),browserSkillBinding=null}={}){
 const config=privateJSON(path),p=config.scopeAuthorization;if(browserSkillBinding)config.browserSkillBinding=browserSkillBinding;
 if(config.version!==1||!p||!p.workspace?.startsWith('ws-')||!p.account_id||!/^[1-9]\d*$/.test(p.actor_id||'')||!/^[1-9]\d*$/.test(p.target_page_id||'')||!p.profile_id||!Number.isSafeInteger(p.expires_at)||p.expires_at<=now()||p.expires_at>now()+86400000||!Array.isArray(p.operations)||p.operations.some(o=>!['PAGE','GROUP','INTERACTION'].includes(o))||!p.operations.length||['task_id','approval_thread_id','approval_message_id'].some(k=>!p.authorization?.[k]?.trim()))fail('EXPLICIT_SCOPED_POLICY_REQUIRED');
 if(!Array.isArray(p.additional_history)||!p.additional_history.length||!p.additional_history.some(s=>s.kind==='V1'))fail('PRODUCTION_LEGACY_HISTORY_COVERAGE_REQUIRED');
 for(const source of p.additional_history){if(!isAbsolute(source.path||'')||!['V1','UNIFIED'].includes(source.kind))fail('COMPLETE_READONLY_HISTORY_REQUIRED');const db=new DatabaseSync(source.path,{readOnly:true});try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),required=source.kind==='V1'?['jobs','facebook_accounts','platform_attempts','platform_receipts','content_snapshots']:['publisher_jobs','facebook_accounts'];if(required.some(t=>!tables.includes(t)))fail('HISTORY_SCHEMA_REQUIRED');}finally{db.close();}
  if(source.kind==='V1'){const paths=source.ledger_paths;if(!Array.isArray(paths?.events)||paths.events.length<2||new Set(paths.events).size!==paths.events.length||!isAbsolute(paths.yaml||''))fail('COMPLETE_V1_LEDGER_PATHS_REQUIRED');for(const file of paths.events){if(!isAbsolute(file))fail('COMPLETE_READONLY_HISTORY_REQUIRED');for(const line of readFileSync(file,'utf8').split(/\r?\n/))if(line.trim())JSON.parse(line);}parse(readFileSync(paths.yaml,'utf8'));}
 }
 if(config.interactionFlow){p.approved_group_ids=validateInteractionFlow(config);if(config.targets?.length)fail('BSK_FLOW_OR_EXACT_TARGETS_REQUIRED');delete p.approved_targets;}
 else p.approved_targets=config.targets?.map(t=>({subject_id:t.kind+':'+t.id,scope_hash:t.scope_hash}));
 return config;
}

// Only an absent scoped-policy variable chooses read-only. Invalid/empty supplied
// paths or policy files must fail, never silently downgrade or synthesize scope.
export function loadMaintenanceConfig(scopedPath,diagnosticPath,reopenPath,manualSyncPath,operatingSettingsPath,browserSkillPath){
 let operatingSettingsScope;if(operatingSettingsPath!==undefined){const st=lstatSync(operatingSettingsPath);if(st.isSymbolicLink()||process.getuid&&st.uid!==process.getuid())fail('OPERATING_SETTINGS_PRIVATE_SCOPE_REQUIRED');operatingSettingsScope=validateOperatingSettingsScope(privateJSON(operatingSettingsPath));}
 let browserSkillBinding;if(browserSkillPath!==undefined){const st=lstatSync(browserSkillPath);if(st.isSymbolicLink()||process.getuid&&st.uid!==process.getuid())fail('BSK_PRIVATE_BINDING_REQUIRED');browserSkillBinding=validateBrowserSkillBinding(privateJSON(browserSkillPath));}
 if(scopedPath!==undefined){if(operatingSettingsPath!==undefined&&browserSkillPath===undefined)fail('OPERATING_SETTINGS_REQUIRES_READ_ONLY');if(manualSyncPath!==undefined)fail('MANUAL_SYNC_REQUIRES_ZERO_SCOPE');if(reopenPath!==undefined)fail('BROWSER_REOPEN_REQUIRES_ZERO_SCOPE');const config=loadScopedConfig(scopedPath,{browserSkillBinding});if(browserSkillBinding){const p=config.scopeAuthorization,b=browserSkillBinding;if(p.operations.some(k=>!['PAGE','GROUP','INTERACTION'].includes(k))||p.workspace!==b.workspace||p.account_id!==b.account_id||p.actor_id!==b.actor_id||p.target_page_id!==b.target_page_id||p.profile_id!=='bsk:'+b.browser_instance_id)fail('BSK_EXACT_OPERATION_POLICY_REQUIRED');config.browserSkillBinding=b;}if(operatingSettingsScope){const p=config.scopeAuthorization,o=operatingSettingsScope;if(p.workspace!==o.workspace||p.account_id!==o.account_id||p.actor_id!==o.actor_id||p.target_page_id!==o.target_page_id)fail('OPERATING_SETTINGS_SCOPE_MISMATCH');config.operatingSettingsScope=o;}return config;}
 let diagnostic;
 if(diagnosticPath!==undefined){const d=privateJSON(diagnosticPath);if(d.version!==1||d.operation!=='FACEBOOK_READ_ONLY_DIAGNOSTIC'||!d.scope)fail('DIAGNOSTIC_PRIVATE_SCOPE_REQUIRED');diagnostic=d.scope;}
 let browserReopen;if(reopenPath!==undefined){const st=lstatSync(reopenPath);if(st.isSymbolicLink()||process.getuid&&st.uid!==process.getuid())fail('BROWSER_REOPEN_PRIVATE_AUTHORIZATION_REQUIRED');browserReopen=privateJSON(reopenPath);}
 let manualContentSync;if(manualSyncPath!==undefined){const st=lstatSync(manualSyncPath);if(st.isSymbolicLink()||process.getuid&&st.uid!==process.getuid())fail('MANUAL_SYNC_PRIVATE_AUTHORIZATION_REQUIRED');manualContentSync=privateJSON(manualSyncPath);}
 return {version:1,mode:'READ_ONLY',...(diagnostic?{diagnostic}:{}),...(browserReopen?{browserReopen}:{}),...(manualContentSync?{manualContentSync}:{}),...(operatingSettingsScope?{operatingSettingsScope}:{}),...(browserSkillBinding?{browserSkillBinding}:{})};
}
export function verifyDiagnosticBinding(dbPath,diag){
 if(!diag)return;
 if(!/^ws-[a-z0-9-]+$/.test(diag.workspace||'')||!/^[a-f0-9-]{36}$/.test(diag.job_id||'')||!diag.account_id||!diag.content_id||!/^[a-f0-9]{64}$/.test(diag.snapshot_hash||'')||!/^\d+$/.test(diag.operator_actor_id||'')||!/^\d+$/.test(diag.target_page_id||'')||!Number.isSafeInteger(diag.media_count)||diag.media_count<0)fail('DIAGNOSTIC_FROZEN_SCOPE_MISMATCH');
 const db=new DatabaseSync(dbPath,{readOnly:true});
 try{const j=db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(diag.job_id),s=j&&JSON.parse(j.snapshot_json);if(!j||j.state!=='UNKNOWN'||j.workspace!==diag.workspace||j.account_id!==diag.account_id||j.snapshot_hash!==diag.snapshot_hash||j.content_id!==diag.content_id||s.platform!=='facebook'||s.transport!=='BROWSER'||s.operatorActorId!==diag.operator_actor_id||s.targetPageId!==diag.target_page_id||s.media.length!==diag.media_count||diag.platform&&diag.platform!=='facebook'||diag.transport&&diag.transport!=='BROWSER')fail('DIAGNOSTIC_FROZEN_SCOPE_MISMATCH');}
 finally{db.close();}
}
