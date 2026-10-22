import {createHash,randomUUID} from 'node:crypto';
import {validateMetricObservation} from './metric-observation.js';

const fail=code=>{throw Error(code);};
const hash=x=>createHash('sha256').update(x).digest('hex');
const digest=x=>hash(JSON.stringify(x));
const text=x=>typeof x==='string'&&x.length>0&&x.length<=1000&&x.trim()===x;
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const exact=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail('METRIC_SHAPE_INVALID');};
const targetKeys=['schema_version','task_id','workspace','account_id','platform','object_id','content_id','content_revision','publication_job_id','operator_actor_id','business_asset_id','source_account_id','source_object_id','source_reference','source_transport','origin','mapping_reference'];
const identityKeys=['operator_actor_id','business_asset_id','source_account_id','source_object_id'];
const metricKeys=['name','definition_id','definition_version','definition_text','unit'];
const binding=t=>Object.fromEntries(['workspace','account_id','platform','object_id','content_revision','publication_job_id','source_reference','source_transport',...identityKeys].map(k=>[k,t[k]]));
const selector=o=>({metric:Object.fromEntries(metricKeys.map(k=>[k,o.metric[k]])),window:o.window});
const flags={publish_allowed:false,source_authenticated:false};

/** Additive evidence ledger, not publishing authority. Local mappings are explicit and unverified. */
export class MetricObservationStore {
 constructor(db){
  this.db=db;db.exec(`PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS metric_targets(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,workspace TEXT NOT NULL,account_id TEXT NOT NULL,publication_job_id TEXT NOT NULL UNIQUE,target_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS metric_series(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,selector_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS metric_observations(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,observed_at TEXT NOT NULL,observation_json TEXT NOT NULL,unavailable_reason TEXT,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS metric_observation_history ON metric_observations(series_id,observed_at,id);
   CREATE TABLE IF NOT EXISTS metric_raw_evidence(observation_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,data BLOB NOT NULL);
   CREATE TABLE IF NOT EXISTS metric_collection_attempts(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,reason TEXT);
   CREATE INDEX IF NOT EXISTS metric_attempt_history ON metric_collection_attempts(series_id,started_at);`);
 }
 tx(fn){const nested=this.db.isTransaction,name='metric_'+randomUUID().replaceAll('-','');this.db.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');try{const result=fn();this.db.exec(nested?'RELEASE '+name:'COMMIT');return result;}catch(error){this.db.exec(nested?'ROLLBACK TO '+name:'ROLLBACK');if(nested)this.db.exec('RELEASE '+name);throw error;}}
 scope(workspace,account){
  const row=this.db.prepare('SELECT * FROM facebook_accounts WHERE workspace=? AND id=?').get(workspace??null,account??null);
  if(!row)fail('METRIC_SCOPE_DENIED');return row;
 }
 registerTarget(input){
  exact(input,targetKeys);if(input.schema_version!==1||targetKeys.filter(k=>k!=='schema_version').some(k=>!text(input[k]))||!['SYNTHETIC','OFFLINE_UNVERIFIED'].includes(input.origin)||!['MANUAL_EXPORT','API_READBACK','BROWSER_READBACK'].includes(input.source_transport)||input.source_object_id!==input.object_id)fail('METRIC_TARGET_INVALID');
  const target=Object.fromEntries(targetKeys.map(k=>[k,input[k]])),id=digest(target);
  return this.tx(()=>{
   const account=this.scope(target.workspace,target.account_id);if(account.platform!==target.platform)fail('METRIC_PLATFORM_MISMATCH');
   if(account.operator_actor_id&&account.operator_actor_id!==target.operator_actor_id||account.target_page_id&&account.target_page_id!==target.business_asset_id)fail('METRIC_ACCOUNT_IDENTITY_MISMATCH');
   if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_reviews'").get()){
    const production=this.db.prepare('SELECT workspace,account_id FROM production_reviews WHERE task_id=? LIMIT 1').get(target.task_id);
    if(production&&(production.workspace!==target.workspace||production.account_id!==target.account_id))fail('METRIC_TASK_SCOPE_CONFLICT');
   }
   const task=this.db.prepare('SELECT workspace FROM metric_targets WHERE task_id=? LIMIT 1').get(target.task_id);
   if(task&&task.workspace!==target.workspace)fail('METRIC_TASK_SCOPE_CONFLICT');
   const job=this.db.prepare('SELECT workspace,account_id,content_id,snapshot_hash FROM publisher_jobs WHERE id=?').get(target.publication_job_id);
   // Existing jobs cannot be attributed to different content/account. A local snapshot revision is its hash.
   if(job&&(job.workspace!==target.workspace||job.account_id!==target.account_id||job.content_id!==target.content_id||job.snapshot_hash!==target.content_revision))fail('METRIC_JOB_MAPPING_CONFLICT');
   const old=this.db.prepare('SELECT id FROM metric_targets WHERE publication_job_id=?').get(target.publication_job_id);
   if(old&&old.id!==id)fail('METRIC_TARGET_CONFLICT');
   if(!old)this.db.prepare('INSERT INTO metric_targets VALUES(?,?,?,?,?,?)').run(id,target.task_id,target.workspace,target.account_id,target.publication_job_id,JSON.stringify(target));
   return {id,status:old?'DUPLICATE':'REGISTERED',mapping_status:'CALLER_DECLARED',...flags};
  });
 }
 target(id,{workspace,accountId}={}){
  this.scope(workspace,accountId);const row=this.db.prepare('SELECT target_json FROM metric_targets WHERE id=? AND workspace=? AND account_id=?').get(id,workspace,accountId);
  if(!row)fail('METRIC_NOT_FOUND');const target=JSON.parse(row.target_json);if(digest(target)!==id)fail('METRIC_STORAGE_CORRUPT');return target;
 }
 checked(target,packet,now){
  exact(packet,['observation','evidenceBytes','unavailable_reason']);
  const observation=validateMetricObservation(packet.observation,{binding:binding(target),evidenceBytes:packet.evidenceBytes,now});
  const reason=packet.unavailable_reason;
  if(observation.metric.availability==='AVAILABLE'?reason!==null:!text(reason))fail('METRIC_UNAVAILABLE_REASON_REQUIRED');
  const {observation_id,...record}=observation,entryId=digest({observation_id,unavailable_reason:reason});
  const shape=selector(record),seriesId=digest({target_id:digest(target),...shape});
  return {record,entryId,seriesId,shape,reason};
 }
 ingest(targetId,packet,{workspace,accountId,now=Date.now(),attemptId=null}={}){
  const target=this.target(targetId,{workspace,accountId}),checked=this.checked(target,packet,now),{record,entryId,seriesId,shape,reason}=checked;
  return this.tx(()=>{
   this.target(targetId,{workspace,accountId});
   this.db.prepare('INSERT OR IGNORE INTO metric_series VALUES(?,?,?)').run(seriesId,targetId,JSON.stringify(shape));
   if(attemptId){const a=this.db.prepare('SELECT * FROM metric_collection_attempts WHERE id=? AND series_id=?').get(attemptId,seriesId);if(!a||a.state!=='RUNNING'||Date.parse(a.started_at)>now)fail('METRIC_ATTEMPT_CONFLICT');}
   const old=this.db.prepare('SELECT * FROM metric_observations WHERE id=?').get(entryId);
   if(old)this.entry(old,target);
   if(!old){
    this.db.prepare('INSERT INTO metric_observations VALUES(?,?,?,?,?,?)').run(entryId,seriesId,record.observed_at,JSON.stringify(record),reason,new Date(now).toISOString());
    this.db.prepare('INSERT INTO metric_raw_evidence VALUES(?,?,?)').run(entryId,record.source.sha256,packet.evidenceBytes);
   }
   const conflicting=this.db.prepare('SELECT id FROM metric_observations WHERE series_id=? AND observed_at=? ORDER BY id').all(seriesId,record.observed_at).map(x=>x.id);
   const status=old?'DUPLICATE':conflicting.length>1?'CONFLICT_RETAINED':'RECORDED';
   if(attemptId)this.db.prepare("UPDATE metric_collection_attempts SET state='RECORDED',finished_at=? WHERE id=?").run(new Date(now).toISOString(),attemptId);
   return {id:entryId,series_id:seriesId,status,conflicting_ids:conflicting.length>1?conflicting:[],origin:target.origin,...flags};
  });
 }
 beginCollection(targetId,shape,{workspace,accountId,now=Date.now()}={}){
  exact(shape,['metric','window']);exact(shape.metric,metricKeys);const target=this.target(targetId,{workspace,accountId}),at=new Date(now).toISOString(),evidenceBytes=Buffer.from('selector validation only');
  const observation={schema_version:1,...Object.fromEntries(['workspace','account_id','platform','object_id','content_revision','publication_job_id'].map(k=>[k,target[k]])),observed_at:at,source:{transport:target.source_transport,reference:target.source_reference,sha256:hash(evidenceBytes)},window:shape.window,metric:{...shape.metric,value:null,availability:'NOT_COLLECTED'},coverage:{scope:'OBJECT',completeness:'UNKNOWN'},identity_evidence:{...Object.fromEntries(identityKeys.map(k=>[k,target[k]])),verified_at:at,method:'MANUAL_REVIEW',reference:target.mapping_reference}};
  const checked=this.checked(target,{observation,evidenceBytes,unavailable_reason:'NOT_COLLECTED'},now),id=randomUUID();
  this.tx(()=>{this.db.prepare('INSERT OR IGNORE INTO metric_series VALUES(?,?,?)').run(checked.seriesId,targetId,JSON.stringify(checked.shape));this.db.prepare('INSERT INTO metric_collection_attempts VALUES(?,?,?,?,?,?)').run(id,checked.seriesId,'RUNNING',at,null,null);});
  return {id,series_id:checked.seriesId,target};
 }
 failCollection(id,{workspace,accountId,reason='COLLECTOR_FAILED',now=Date.now()}={}){
  if(!['COLLECTOR_FAILED','COLLECTOR_TIMEOUT','COLLECTOR_INVALID_RESULT','COLLECTOR_INTERRUPTED'].includes(reason))fail('METRIC_FAILURE_REASON_INVALID');
  return this.tx(()=>{this.scope(workspace,accountId);const a=this.db.prepare('SELECT a.* FROM metric_collection_attempts a JOIN metric_series s ON s.id=a.series_id JOIN metric_targets t ON t.id=s.target_id WHERE a.id=? AND t.workspace=? AND t.account_id=?').get(id,workspace,accountId);
   if(!a)fail('METRIC_NOT_FOUND');if(a.state!=='RUNNING'||!Number.isFinite(now)||now<Date.parse(a.started_at))fail('METRIC_ATTEMPT_CONFLICT');
   this.db.prepare("UPDATE metric_collection_attempts SET state='FAILED',finished_at=?,reason=? WHERE id=?").run(new Date(now).toISOString(),reason,id);return {status:'FAILED',reason,value:null,...flags};});
 }
 entry(row,target){
  const raw=this.db.prepare('SELECT * FROM metric_raw_evidence WHERE observation_id=?').get(row.id);if(!raw||hash(raw.data)!==raw.sha256)fail('METRIC_STORAGE_CORRUPT');
  const record=JSON.parse(row.observation_json),checked=this.checked(target,{observation:record,evidenceBytes:Buffer.from(raw.data),unavailable_reason:row.unavailable_reason},Date.now());
  if(checked.entryId!==row.id||checked.seriesId!==row.series_id||record.observed_at!==row.observed_at||record.source.sha256!==raw.sha256)fail('METRIC_STORAGE_CORRUPT');
  return {id:row.id,observation:record,unavailable_reason:row.unavailable_reason,origin:target.origin};
 }
 seriesRow(id,workspace,accountId){
  this.scope(workspace,accountId);const row=this.db.prepare('SELECT s.*,t.target_json FROM metric_series s JOIN metric_targets t ON t.id=s.target_id WHERE s.id=? AND t.workspace=? AND t.account_id=?').get(id,workspace,accountId);
  if(!row)fail('METRIC_NOT_FOUND');const target=JSON.parse(row.target_json),shape=JSON.parse(row.selector_json);if(digest(target)!==row.target_id||digest({target_id:row.target_id,...shape})!==id)fail('METRIC_STORAGE_CORRUPT');return {target,shape};
 }
 snapshot(id,{workspace,accountId,asOf=new Date().toISOString()}={}){
  if(!iso(asOf)||Date.parse(asOf)>Date.now())fail('METRIC_AS_OF_INVALID');
  const {target,shape}=this.seriesRow(id,workspace,accountId);
  const latest=this.db.prepare('SELECT max(observed_at) at FROM metric_observations WHERE series_id=? AND observed_at<=?').get(id,asOf).at;
  const rows=latest?this.db.prepare('SELECT * FROM metric_observations WHERE series_id=? AND observed_at=? ORDER BY id LIMIT 101').all(id,latest):[];
  const failed=this.db.prepare("SELECT * FROM metric_collection_attempts WHERE series_id=? AND started_at<=? AND (state!='RECORDED' OR finished_at>?) ORDER BY COALESCE(finished_at,started_at) DESC,id DESC LIMIT 1").get(id,asOf,asOf);
  const effective=failed&&(failed.finished_at&&failed.finished_at<=asOf?failed.finished_at:failed.started_at);
  let status='NOT_COLLECTED',value=null,reason='NO_OBSERVATIONS',entries=[];
  if(rows.length>100){status='CONFLICT';reason='CONFLICT_HISTORY_LIMIT';}
  else if(rows.length){entries=rows.map(row=>this.entry(row,target));status=entries.length>1?'CONFLICT':entries[0].observation.metric.availability;reason=entries.length>1?'CONFLICTING_AS_OF_SNAPSHOT':entries[0].unavailable_reason;value=status==='AVAILABLE'?entries[0].observation.metric.value:null;}
  if(failed&&(!latest||effective>=latest)){status=failed.finished_at&&failed.finished_at<=asOf?'COLLECTION_FAILED':'COLLECTION_PENDING';value=null;reason=status==='COLLECTION_FAILED'?failed.reason:'AWAITING_RECONCILIATION';}
  return {series_id:id,target,selector:shape,as_of:asOf,status,value,reason,observed_at:latest,collection_attempt:failed||null,observation_ids:entries.map(x=>x.id),origin:target.origin,...flags};
 }
 list(workspace,accountId,{cursor='',asOf=new Date().toISOString()}={}){
  this.scope(workspace,accountId);if(cursor&&!/^[a-f0-9]{64}$/.test(cursor))fail('METRIC_CURSOR_INVALID');
  const rows=this.db.prepare('SELECT s.id FROM metric_series s JOIN metric_targets t ON t.id=s.target_id WHERE t.workspace=? AND t.account_id=? AND s.id>? ORDER BY s.id LIMIT 21').all(workspace,accountId,cursor);
  return {snapshots:rows.slice(0,20).map(x=>this.snapshot(x.id,{workspace,accountId,asOf})),next_cursor:rows.length>20?rows[19].id:null,as_of:asOf,aggregation:'NOT_PERFORMED',...flags};
 }
 history(id,{workspace,accountId,before=null}={}){
  const {target}=this.seriesRow(id,workspace,accountId);if(before&&!/^[a-f0-9]{64}$/.test(before))fail('METRIC_CURSOR_INVALID');
  // Stable ID pagination; display uses explicit source timestamps, never insertion order.
  const rows=this.db.prepare('SELECT * FROM metric_observations WHERE series_id=? AND id>? ORDER BY id LIMIT 21').all(id,before||'');
  return {entries:rows.slice(0,20).map(row=>this.entry(row,target)),next_cursor:rows.length>20?rows[19].id:null,snapshot:this.snapshot(id,{workspace,accountId})};
 }
 evidence(id,{workspace,accountId}={}){
  this.scope(workspace,accountId);const row=this.db.prepare('SELECT o.*,t.target_json FROM metric_observations o JOIN metric_series s ON s.id=o.series_id JOIN metric_targets t ON t.id=s.target_id WHERE o.id=? AND t.workspace=? AND t.account_id=?').get(id,workspace,accountId);
  if(!row)fail('METRIC_NOT_FOUND');this.entry(row,JSON.parse(row.target_json));return this.db.prepare('SELECT sha256,data FROM metric_raw_evidence WHERE observation_id=?').get(id);
 }
}
