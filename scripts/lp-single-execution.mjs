import {existsSync,realpathSync} from 'node:fs';
import {isAbsolute,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {SingleExecutionPermits} from '../src/single-execution-permit.js';

// This command cannot issue a permit for any other job or content revision.
const scope={job_id:'ffeadf9c-10de-4e22-84f0-bd186adcefbc',content_id:'38043ea3-133a-4ba7-a50d-7c5658d1d704',
  workspace:'ws-99076aaf-0bfb-4766-9d30-cf6d0411f4b6',account_id:'63296af8-7f41-42bc-bdf2-529c5ae28c5b',
  operator_actor_id:'61594159443807',target_page_id:'1459220443931651',platform:'facebook',transport:'BROWSER',
  snapshot_hash:'fef33ef459d076ab9bb98ebd4c43b512b4119a74590233d8dc18945e8a9f0d76',media_count:0};
const authorization={task_id:'VB-PUBLISHER-V1-V2-INTEGRATION-PLAN-20261005-001',
  approval_thread_id:'01a10b95-3862-704e-99eb-177948c3e023',approval_message_id:'Sentinel_096cc9979fe08191bb1fb47345203dd3',
  approved_at:'2026-10-07T09:40:00Z',description:'User approved this LP frozen promotion once; other execution and scheduler remain disabled.'};
const [path,action]=process.argv.slice(2);
if(!path||!isAbsolute(path)||!existsSync(path)||basename(path)!=='publisher-unified.sqlite'||!['--grant','--revoke'].includes(action))
  throw Error('用法：node scripts/lp-single-execution.mjs /现有私有目录/publisher-unified.sqlite --grant 或 --revoke');
const database=realpathSync(path),check=new DatabaseSync(database,{readOnly:true});
try {
  for(const name of ['publisher_jobs','publisher_prepare_intents','publisher_submit_intents','publisher_submit_receipts','publisher_job_assets'])
    if(!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw Error('不是已部署的统一 Publisher 数据库');
}finally{check.close();}
const store=new Store(database,{seedDemo:false});
try {
  const publisher=new UnifiedPublisher(store),permits=new SingleExecutionPermits(publisher);
  const result=action==='--grant'?permits.issue(scope.workspace,scope.job_id,scope,{expiresAt:Date.now()+2*3600000,authorization})
    :permits.revoke(scope.workspace,scope.job_id,'Mac explicitly revoked the approved LP one-time execution');
  console.log(JSON.stringify({job_id:scope.job_id,scope,...result},null,2));
}finally{store.close();}
