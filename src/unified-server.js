import {isAbsolute,basename,dirname,join} from 'node:path';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from './server.js';
import {cloudRuntime} from './cloud-runtime.js';
import {BrowserResources} from './browser-resources.js';
import {contentSyncOptions} from './content-sync.js';
import {loadMaintenanceConfig,loadPageHistoryConfig,verifyDiagnosticBinding} from '../maintenance/scoped-config.mjs';

// Explicit opt-in. Never reuse a legacy publisher/operator database by default.
const path=process.argv[2];
if(!path||!isAbsolute(path)||basename(path)!=='publisher-unified.sqlite')throw Error('请指定新的绝对路径 publisher-unified.sqlite');
if(existsSync(path)) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publisher_jobs'").get())throw Error('此文件不是统一版本数据库，不能复用旧运行数据库');
    if(!db.prepare("SELECT sql FROM sqlite_master WHERE name='publisher_jobs'").get().sql.includes('DRAFT_WRITTEN'))throw Error('此文件属于旧 Facebook 阶段 schema；请使用独立新目录，旧文件保留，不做原地迁移');
  } finally {db.close();}
}
if(cloudRuntime()?.mode!=='mac-tunnel')throw Error('统一入口需要已认证的 mac-tunnel 模式');
const retained=loadMaintenanceConfig(undefined,process.env.PUBLISHER_READONLY_DIAGNOSTIC_CONFIG,process.env.PUBLISHER_BROWSER_REOPEN_AUTHORIZATION_FILE);
verifyDiagnosticBinding(path,retained.diagnostic);
let scopeAuthorization;
if(process.env.PUBLISHER_SCOPED_AUTHORIZATION_FILE){const file=process.env.PUBLISHER_SCOPED_AUTHORIZATION_FILE;if(!isAbsolute(file)||!statSync(file).isFile()||(statSync(file).mode&0o077))throw Error('PRIVATE_SCOPED_AUTHORIZATION_FILE_REQUIRED');scopeAuthorization=JSON.parse(readFileSync(file,'utf8'));if(!scopeAuthorization.additional_history?.some(s=>s.kind==='V1'&&s.ledger_paths?.yaml&&Array.isArray(s.ledger_paths.events)&&s.ledger_paths.events.length>=2))throw Error('PRODUCTION_LEGACY_HISTORY_COVERAGE_REQUIRED');}
const pageAccount=process.env.PUBLISHER_PAGE_ACCOUNT_ID,pageNewAfter=process.env.PUBLISHER_PAGE_NEW_JOBS_AFTER,pageBlockedDay=process.env.PUBLISHER_PAGE_BLOCKED_OPERATING_DAY;
const exactTime=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
let pageExecution=null;
if(process.env.PUBLISHER_ENABLE_PAGE_EXECUTION==='1'){
 if(!pageAccount||!exactTime(pageNewAfter)||!/^(?:20\d{2})-\d{2}-\d{2}$/.test(pageBlockedDay||'')||process.env.PUBLISHER_PAGE_SUBMIT_NOT_BEFORE||process.env.PUBLISHER_ENABLE_EXECUTION!=='0'||process.env.PUBLISHER_ENABLE_SCAN_SCHEDULER!=='0'||process.env.PUBLISHER_ENABLE_CONTENT_SYNC!=='0')throw Error('INTERACTIVE_PAGE_EXACT_BOUND_CONFIGURATION_REQUIRED');
 pageExecution={accountId:pageAccount,newJobsAfter:Date.parse(pageNewAfter),blockedOperatingDay:pageBlockedDay,additionalHistory:loadPageHistoryConfig(process.env.PUBLISHER_PAGE_HISTORY_FILE)};
}
const release=new BrowserResources(join(dirname(path),'service-locks')).acquire(path,'unified-service',()=>false,{reconcile:true});
let server;
try{server=createApp(path,{unified:true,recoverStartup:!pageExecution,recoverScopedStartup:process.env.PUBLISHER_ENABLE_GROUP_INTERACTION==='1',scopeAuthorization,readOnlyDiagnosticScope:retained.diagnostic,browserReopenAuthorization:retained.browserReopen,executionEnabled:process.env.PUBLISHER_ENABLE_EXECUTION==='1',v3BridgeEnabled:process.env.PUBLISHER_ENABLE_V3_BRIDGE==='1',pageExecution,interactiveScoped:process.env.PUBLISHER_ENABLE_GROUP_INTERACTION==='1'?{accountId:pageAccount,additionalHistory:pageExecution?.additionalHistory}:null,scanScheduler:process.env.PUBLISHER_ENABLE_SCAN_SCHEDULER==='1',contentSync:contentSyncOptions(),library:{roots:process.env.CONTENT_ROOTS_JSON?JSON.parse(process.env.CONTENT_ROOTS_JSON):undefined,gptInboxBase:process.env.GPT_INBOX_BASE}});}catch(error){release();throw error;}
server.on('storage-closed',release);
server.on('error',()=>server.close());
server.listen(Number(process.env.PORT||17882),'127.0.0.1',()=>console.log('VietBridge unified authenticated service ready'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
