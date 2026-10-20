import {isAbsolute,basename,dirname,join} from 'node:path';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from './server.js';
import {cloudRuntime} from './cloud-runtime.js';
import {BrowserResources} from './browser-resources.js';

const cloud=cloudRuntime();
if(cloud?.mode!=='cloud')throw Error('UNIFIED_CLOUD_MODE_REQUIRED');
for(const key of ['PUBLISHER_ENABLE_EXECUTION','PUBLISHER_ENABLE_PAGE_EXECUTION','PUBLISHER_ENABLE_GROUP_INTERACTION','PUBLISHER_ENABLE_SCAN_SCHEDULER','PUBLISHER_ENABLE_CONTENT_SYNC']) {
  if(process.env[key] && process.env[key]!=='0')throw Error('CLOUD_EXECUTION_DISABLED: '+key);
}
for(const key of ['PUBLISHER_SCOPED_AUTHORIZATION_FILE','PUBLISHER_READONLY_DIAGNOSTIC_CONFIG','PUBLISHER_BROWSER_REOPEN_AUTHORIZATION_FILE']) {
  if(process.env[key])throw Error('CLOUD_LOCAL_CAPABILITY_UNAVAILABLE: '+key);
}
const host=process.env.PUBLISHER_CLOUD_BIND_HOST||'127.0.0.1';
if(!['127.0.0.1','0.0.0.0'].includes(host))throw Error('INVALID_CLOUD_BIND_HOST');
const port=Number(process.env.PORT||17882);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_CLOUD_PORT');

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

const release=new BrowserResources(join(dirname(path),'service-locks')).acquire(path,'unified-service',()=>false,{reconcile:true});
let server;
try {
  server=createApp(path,{cloud,unified:true,recoverStartup:false,executionEnabled:false,scanScheduler:false});
} catch(error) {release();throw error;}
server.on('storage-closed',release);
server.on('error',error=>{console.error(error.message);process.exitCode=1;server.close();release();});
server.listen(port,host,()=>console.log(JSON.stringify({service:'publisher-unified-cloud',host,port:server.address().port,executionEnabled:false})));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
