import {createHash,randomUUID} from 'node:crypto';
import {assertPendingObservationLease} from './composer-observation.js';
import {boundedRead} from './publisher-core/facebook-readiness-observation.ts';
import {executionScope} from './single-execution-permit.js';
import {boundedDiagnosticCleanup} from './facebook-readonly-diagnostics.js';
const safe=error=>String(error?.message||error).replace(/EAA[A-Za-z0-9_-]+|Bearer\s+\S+/g,'[REDACTED]').slice(0,600);
/** Separate append-only run records. Never calls complete, claim, prepare, submit or permit APIs. */
export class PublisherDiagnostics{
  constructor(executor,{composerObservation=false,maintenanceScope,observationBudgetMs=22000,cleanupBudgetMs=4500}={}){this.observation=composerObservation;this.maintenanceScope=maintenanceScope?Object.freeze({...maintenanceScope}):null;this.observationBudgetMs=observationBudgetMs;this.cleanupBudgetMs=cleanupBudgetMs;this.stopped=false;this.table=composerObservation?'publisher_composer_observations':'publisher_diagnostic_runs';this.executor=executor;this.publisher=executor.publisher;this.db=executor.db;this.running=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table}(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES publisher_jobs(id),workspace TEXT NOT NULL,scope_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('RUNNING','DONE')),result_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS ${this.observation?'publisher_composer_observations_single_run':'publisher_diagnostic_single_run'} ON ${this.table}(job_id) WHERE state='RUNNING';`);
  }
  recover(){this.db.prepare(`UPDATE ${this.table} SET state='DONE',result_json=?,updated_at=? WHERE state='RUNNING'`).run(JSON.stringify({conclusion:'INCOMPLETE',absenceProven:false,stage:'INTERRUPTED',errors:[{stage:'RECOVERY',error:'SERVICE_INTERRUPTED_DIAGNOSTIC_NO_PLATFORM_WRITE'}]}),new Date().toISOString());}
  view(workspace,id){this.publisher.job(workspace,id);const row=this.db.prepare(`SELECT * FROM ${this.table} WHERE workspace=? AND job_id=? ORDER BY created_at DESC LIMIT 1`).get(workspace,id);return row?{id:row.id,jobId:row.job_id,state:row.state,scope:JSON.parse(row.scope_json),result:JSON.parse(row.result_json),createdAt:row.created_at,updatedAt:row.updated_at}:{state:'NOT_STARTED'};}
  async stop(){this.stopped=true;await Promise.allSettled([...this.running.values()]);}
  assertMaintenanceScope(job){
    const scope=executionScope(job),bound=this.maintenanceScope;
    if(!bound||Object.keys(scope).some(key=>scope[key]!==bound[key]&&!(bound[key]===undefined&&['platform','transport'].includes(key))))throw Error('DIAGNOSTIC_FROZEN_SCOPE_MISMATCH');
    if(this.stopped||job.state!=='UNKNOWN'||job.snapshot.platform!=='facebook'||job.snapshot.transport!=='BROWSER')throw Error('DIAGNOSTIC_UNKNOWN_BROWSER_REQUIRED');
    this.publisher.assertCurrent(job);
    assertPendingObservationLease(this.executor,job.snapshot);
    if(this.executor.active.has(job.snapshot.profileId))throw Error('DIAGNOSTIC_PROFILE_BUSY');
  }
  maintenanceCapability(workspace,id,principal){
    if(principal?.type!=='admin'||!this.maintenanceScope)return {canStart:false,reason:'MAINTENANCE_READ_ONLY'};
    try{const job=this.publisher.job(workspace,id);this.assertMaintenanceScope(job);return {canStart:true,operation:'FACEBOOK_READ_ONLY_DIAGNOSTIC',scope:executionScope(job)};}
    catch(error){return {canStart:false,reason:safe(error)};}
  }
  start(workspace,id,input){
    if(this.stopped)throw Error('OBSERVATION_SERVICE_STOPPING');
    const job=this.publisher.job(workspace,id),s=job.snapshot;
    if(job.state!=='UNKNOWN'||s.platform!=='facebook'||s.transport!=='BROWSER'||input.snapshot_hash!==job.snapshot_hash)throw Error('只读诊断仅适用完整匹配冻结版本的 Facebook 浏览器 UNKNOWN 任务');
    this.publisher.assertCurrent(job);
    if(this.maintenanceScope)this.assertMaintenanceScope(job);
    if(this.observation){const scope={...executionScope(job),profile_id:s.profileId};for(const [key,value] of Object.entries(scope))if(input[key]!==value)throw Error('OBSERVATION_EXACT_SCOPE_REQUIRED');const prior=this.view(workspace,id);if(prior.state!=='NOT_STARTED')return prior;assertPendingObservationLease(this.executor,s);}

    if(this.executor.active.has(s.profileId)||this.db.prepare(`SELECT 1 FROM ${this.table} WHERE job_id=? AND state='RUNNING'`).get(id))throw Error('此执行环境或任务已有正在进行的操作');
    const release=this.executor.acquireResources(s,{reconcile:true}),runId=randomUUID(),at=new Date().toISOString();this.executor.active.add(s.profileId);
    try{this.db.prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?, 'RUNNING',?,?,?)`).run(runId,id,workspace,JSON.stringify(this.observation?{...executionScope(job),profile_id:s.profileId,profile_resource_sha256:createHash('sha256').update(s.profileDir).digest('hex')}:executionScope(job)),JSON.stringify({kind:this.observation?'COMPOSER_OBSERVATION':'PUBLICATION_DIAGNOSTIC',stage:'STARTING',conclusion:'INCOMPLETE',absenceProven:false}),at,at);}catch(error){this.executor.active.delete(s.profileId);release();throw error;}
    const work=this.work(job,runId,release);this.running.set(runId,work);work.then(()=>this.running.delete(runId),()=>this.running.delete(runId));
    return this.view(workspace,id);
  }
  save(runId,result,state='RUNNING'){this.db.prepare(`UPDATE ${this.table} SET result_json=?,state=?,updated_at=? WHERE id=?`).run(JSON.stringify(result),state,new Date().toISOString(),runId);}
  async work(job,runId,release){let driver,result,retainLease=false,acceptProgress=true;
    try{driver=await (this.observation?boundedRead(()=>this.executor.drivers.create(job.snapshot),1500):this.executor.drivers.create(job.snapshot));if(this.observation){if(!driver.observeComposer)throw Error('OBSERVATION_DRIVER_UNAVAILABLE');result=await boundedRead(()=>driver.observeComposer(job.snapshot,value=>{if(acceptProgress)this.save(runId,value);}),this.observationBudgetMs);}else{if(!driver.diagnose)throw Error('此执行器没有只读诊断能力');result=await driver.diagnose(job.snapshot,value=>this.save(runId,value));}}
    catch(error){retainLease=this.observation&&['READINESS_OBSERVATION_TIMEOUT','OBSERVATION_CONNECT_FAILED','OBSERVATION_PROFILE_MAPPING_OR_CONNECTION_BLOCKED'].includes(error?.message);const row=this.db.prepare(`SELECT result_json FROM ${this.table} WHERE id=?`).get(runId);result={...JSON.parse(row.result_json),conclusion:'BLOCKED',absenceProven:false,stage:'ERROR',errors:[...(JSON.parse(row.result_json).errors||[]),{stage:'DRIVER',error:this.observation?(/^[A-Z_]{1,80}$/.test(error?.message||'')?error.message:'OBSERVATION_FAILED'):safe(error)}]};}
    finally{acceptProgress=false;let cleanupFailed=retainLease;if(retainLease)result={...result,leaseRetained:true};try{await boundedDiagnosticCleanup(()=>driver?.closeDiagnostic?driver.closeDiagnostic():driver?.close(),this.cleanupBudgetMs);}catch(error){cleanupFailed=true;result={...result,conclusion:'BLOCKED',absenceProven:false,leaseRetained:true,errors:[...(result?.errors||[]),{stage:'DISCONNECT',error:this.observation?(/^[A-Z_]{1,80}$/.test(error?.message||'')?error.message:'OBSERVATION_FAILED'):safe(error)}]};}finally{if(!cleanupFailed){try{release();}catch(error){result={...result,conclusion:'BLOCKED',absenceProven:false,leaseRetained:this.observation,errors:[...(result?.errors||[]),{stage:'LEASE',error:this.observation?(/^[A-Z_]{1,80}$/.test(error?.message||'')?error.message:'OBSERVATION_FAILED'):safe(error)}]};}if(!this.observation||!result?.leaseRetained)this.executor.active.delete(job.snapshot.profileId);}this.save(runId,result,'DONE');}}
  }
}
