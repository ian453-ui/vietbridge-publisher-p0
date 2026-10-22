import {validateMetricObservationCore} from '../metric-observation-core.js';
import {AsyncStorage,bytes,digest,sha256,exact,text,iso,fail} from './async-storage.js';

const targetKeys=['schema_version','task_id','workspace','account_id','platform','object_id','content_id','content_revision','publication_job_id','operator_actor_id','business_asset_id','source_account_id','source_object_id','source_reference','source_transport','origin','mapping_reference'];
const identityKeys=['operator_actor_id','business_asset_id','source_account_id','source_object_id'];
const metricKeys=['name','definition_id','definition_version','definition_text','unit'];
const binding=t=>Object.fromEntries(['workspace','account_id','platform','object_id','content_revision','publication_job_id','source_reference','source_transport',...identityKeys].map(k=>[k,t[k]]));
const flags={publish_allowed:false,source_authenticated:false};
export const CLOUD_METRIC_RAW_LIMIT=256*1024;

/** Async port of the existing ledger. No collection/network/authentication here.
 * The same canonical validator and ID byte ordering are shared with the native store.
 */
export class AsyncMetricStore extends AsyncStorage {
 async registerTarget(input){
  exact(input,targetKeys,'METRIC_SHAPE_INVALID');
  if(input.schema_version!==1||targetKeys.filter(k=>k!=='schema_version').some(k=>!text(input[k]))||!['SYNTHETIC','OFFLINE_UNVERIFIED'].includes(input.origin)||!['MANUAL_EXPORT','API_READBACK','BROWSER_READBACK'].includes(input.source_transport)||input.source_object_id!==input.object_id)fail('METRIC_TARGET_INVALID');
  const t=Object.fromEntries(targetKeys.map(k=>[k,input[k]])),id=await digest(t),a=await this.scope(t.workspace,t.account_id);
  if(a.platform!==t.platform)fail('METRIC_PLATFORM_MISMATCH');
  const old=await this.one('SELECT id FROM metric_targets WHERE publication_job_id=?',[t.publication_job_id]);if(old&&old.id!==id)fail('METRIC_TARGET_CONFLICT');
  await this.batch([this.scopeGuard(t.workspace,t.account_id),...this.taskBinding(t.task_id,t.workspace,t.account_id),
   this.guard('EXISTS(SELECT 1 FROM publisher_jobs WHERE id=? AND workspace=? AND account_id=? AND content_id=? AND snapshot_hash=?)',[t.publication_job_id,t.workspace,t.account_id,t.content_id,t.content_revision]),
   this.statement('INSERT INTO metric_targets VALUES(?,?,?,?,?,?) ON CONFLICT(publication_job_id) DO NOTHING',[id,t.task_id,t.workspace,t.account_id,t.publication_job_id,JSON.stringify(t)]),
   this.guard('EXISTS(SELECT 1 FROM metric_targets WHERE id=? AND target_json=?)',[id,JSON.stringify(t)])]);
  return {id,status:old?'DUPLICATE':'REGISTERED',mapping_status:'CALLER_DECLARED',...flags};
 }
 async target(id,{workspace,accountId}={}){
  await this.scope(workspace,accountId);const row=await this.one('SELECT target_json FROM metric_targets WHERE id=? AND workspace=? AND account_id=?',[id,workspace,accountId]);
  if(!row)fail('METRIC_NOT_FOUND');const target=JSON.parse(row.target_json);if(await digest(target)!==id)fail('METRIC_STORAGE_CORRUPT');return target;
 }
 async checked(target,packet,now){
  exact(packet,['observation','evidenceBytes','unavailable_reason'],'METRIC_SHAPE_INVALID');const raw=bytes(packet.evidenceBytes);
  if(raw.byteLength<1||raw.byteLength>CLOUD_METRIC_RAW_LIMIT)fail('METRIC_EVIDENCE_BUDGET');
  const record=validateMetricObservationCore(packet.observation,{binding:binding(target),evidenceSha256:await sha256(raw),evidenceLength:raw.byteLength,now}),reason=packet.unavailable_reason;
  if(record.metric.availability==='AVAILABLE'?reason!==null:!text(reason))fail('METRIC_UNAVAILABLE_REASON_REQUIRED');
  const observation_id=await digest(record),entryId=await digest({observation_id,unavailable_reason:reason}),shape={metric:Object.fromEntries(metricKeys.map(k=>[k,record.metric[k]])),window:record.window};
  return {record,entryId,shape,reason,raw,seriesId:await digest({target_id:await digest(target),...shape})};
 }
 async ingest(targetId,packet,{workspace,accountId,now=Date.now(),attemptId=null}={}){
  const target=await this.target(targetId,{workspace,accountId}),{record,entryId,shape,reason,raw,seriesId}=await this.checked(target,packet,now),old=await this.one('SELECT * FROM metric_observations WHERE id=?',[entryId]);
  if(old)await this.entry(old,target);
  const statements=[this.scopeGuard(workspace,accountId),this.statement('INSERT INTO metric_series VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',[seriesId,targetId,JSON.stringify(shape)])];
  if(attemptId)statements.push(this.guard("EXISTS(SELECT 1 FROM metric_collection_attempts WHERE id=? AND series_id=? AND state='RUNNING' AND started_at<=?)",[attemptId,seriesId,new Date(now).toISOString()]));
  statements.push(this.statement('INSERT INTO metric_observations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',[entryId,seriesId,record.observed_at,JSON.stringify(record),reason,new Date(now).toISOString(),attemptId?'COLLECTOR':'OFFLINE']),
   this.statement('INSERT INTO metric_raw_evidence VALUES(?,?,?) ON CONFLICT(observation_id) DO NOTHING',[entryId,record.source.sha256,Uint8Array.from(raw).buffer]));
  if(attemptId)statements.push(this.statement('INSERT INTO metric_attempt_observations VALUES(?,?)',[attemptId,entryId]),this.statement("UPDATE metric_collection_attempts SET state='RECORDED',finished_at=? WHERE id=? AND state='RUNNING'",[new Date(now).toISOString(),attemptId]));
  await this.batch(statements);
  const conflicting=(await this.rows('SELECT id FROM metric_observations WHERE series_id=? AND observed_at=? ORDER BY id LIMIT 101',[seriesId,record.observed_at])).map(r=>r.id);
  return {id:entryId,series_id:seriesId,status:old?'DUPLICATE':conflicting.length>1?'CONFLICT_RETAINED':'RECORDED',conflicting_ids:conflicting.length>1?conflicting:[],origin:target.origin,...flags};
 }
 async beginCollection(targetId,shape,{workspace,accountId,now=Date.now()}={}){
  exact(shape,['metric','window']);exact(shape.metric,metricKeys);const target=await this.target(targetId,{workspace,accountId}),at=new Date(now).toISOString(),raw=new TextEncoder().encode('selector validation only');
  const observation={schema_version:1,...Object.fromEntries(['workspace','account_id','platform','object_id','content_revision','publication_job_id'].map(k=>[k,target[k]])),observed_at:at,source:{transport:target.source_transport,reference:target.source_reference,sha256:await sha256(raw)},window:shape.window,metric:{...shape.metric,value:null,availability:'NOT_COLLECTED'},coverage:{scope:'OBJECT',completeness:'UNKNOWN'},identity_evidence:{...Object.fromEntries(identityKeys.map(k=>[k,target[k]])),verified_at:at,method:'MANUAL_REVIEW',reference:target.mapping_reference}};
  const checked=await this.checked(target,{observation,evidenceBytes:raw,unavailable_reason:'NOT_COLLECTED'},now),id=crypto.randomUUID();
  await this.batch([this.scopeGuard(workspace,accountId),this.statement('INSERT INTO metric_series VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',[checked.seriesId,targetId,JSON.stringify(checked.shape)]),
   this.statement("INSERT INTO metric_collection_attempts SELECT ?,?,'RUNNING',?,NULL,NULL,COALESCE(max(generation),0)+1 FROM metric_collection_attempts WHERE series_id=?",[id,checked.seriesId,at,checked.seriesId])]);
  return {id,series_id:checked.seriesId,target};
 }
 async failCollection(id,{workspace,accountId,reason='COLLECTOR_FAILED',now=Date.now()}={}){
  if(!['COLLECTOR_FAILED','COLLECTOR_TIMEOUT','COLLECTOR_INVALID_RESULT','COLLECTOR_INTERRUPTED'].includes(reason))fail('METRIC_FAILURE_REASON_INVALID');
  if(!Number.isFinite(now))fail('METRIC_ATTEMPT_CONFLICT');const at=new Date(now).toISOString();
  await this.batch([this.scopeGuard(workspace,accountId),this.guard("EXISTS(SELECT 1 FROM metric_collection_attempts a JOIN metric_series s ON s.id=a.series_id JOIN metric_targets t ON t.id=s.target_id WHERE a.id=? AND t.workspace=? AND t.account_id=? AND a.state='RUNNING' AND a.started_at<=?)",[id,workspace,accountId,at]),
   this.statement("UPDATE metric_collection_attempts SET state='FAILED',finished_at=?,reason=? WHERE id=? AND state='RUNNING'",[at,reason,id])]);return {status:'FAILED',reason,value:null,...flags};
 }
 async entry(row,target){
  const raw=await this.one('SELECT * FROM metric_raw_evidence WHERE observation_id=?',[row.id]);if(!raw||await sha256(bytes(raw.data))!==raw.sha256)fail('METRIC_STORAGE_CORRUPT');
  const record=JSON.parse(row.observation_json),checked=await this.checked(target,{observation:record,evidenceBytes:bytes(raw.data),unavailable_reason:row.unavailable_reason},Date.now());
  if(checked.entryId!==row.id||checked.seriesId!==row.series_id||record.observed_at!==row.observed_at||record.source.sha256!==raw.sha256)fail('METRIC_STORAGE_CORRUPT');return {id:row.id,observation:record,unavailable_reason:row.unavailable_reason,origin:target.origin};
 }
 async seriesRow(id,workspace,accountId){
  await this.scope(workspace,accountId);const row=await this.one('SELECT s.*,t.target_json FROM metric_series s JOIN metric_targets t ON t.id=s.target_id WHERE s.id=? AND t.workspace=? AND t.account_id=?',[id,workspace,accountId]);if(!row)fail('METRIC_NOT_FOUND');
  const target=JSON.parse(row.target_json),shape=JSON.parse(row.selector_json);if(await digest(target)!==row.target_id||await digest({target_id:row.target_id,...shape})!==id)fail('METRIC_STORAGE_CORRUPT');return {target,shape};
 }
 async snapshot(id,{workspace,accountId,asOf=new Date().toISOString()}={}){
  if(!iso(asOf)||Date.parse(asOf)>Date.now())fail('METRIC_AS_OF_INVALID');const {target,shape}=await this.seriesRow(id,workspace,accountId);
  const attempt=await this.one("SELECT *,CASE WHEN finished_at IS NULL OR finished_at>? THEN 'RUNNING' ELSE state END as_of_state FROM metric_collection_attempts WHERE series_id=? AND started_at<=? ORDER BY generation DESC,started_at DESC,id DESC LIMIT 1",[asOf,id,asOf]);
  const generation=(await this.one("SELECT COALESCE(max(generation),0) n FROM metric_collection_attempts WHERE series_id=? AND generation>0 AND state='RECORDED' AND finished_at<=?",[id,asOf])).n;
  const eligible="(o.collection_origin!='COLLECTOR' OR EXISTS(SELECT 1 FROM metric_attempt_observations l JOIN metric_collection_attempts a ON a.id=l.attempt_id WHERE l.observation_id=o.id AND a.generation=? AND a.state='RECORDED' AND a.finished_at<=?))";
  const latest=(await this.one('SELECT max(o.observed_at) at FROM metric_observations o WHERE o.series_id=? AND o.observed_at<=? AND '+eligible,[id,asOf,generation,asOf])).at;
  const rows=latest?await this.rows('SELECT o.* FROM metric_observations o WHERE o.series_id=? AND o.observed_at=? AND '+eligible+' ORDER BY o.id LIMIT 101',[id,latest,generation,asOf]):[];
  let status='NOT_COLLECTED',value=null,reason='NO_OBSERVATIONS';const entries=[];
  if(rows.length>100){status='CONFLICT';reason='CONFLICT_HISTORY_LIMIT';}else if(rows.length){for(const row of rows)entries.push(await this.entry(row,target));status=entries.length>1?'CONFLICT':entries[0].observation.metric.availability;reason=entries.length>1?'CONFLICTING_AS_OF_SNAPSHOT':entries[0].unavailable_reason;value=status==='AVAILABLE'?entries[0].observation.metric.value:null;}
  const independentNewer=attempt&&rows.length&&rows.every(r=>r.collection_origin==='OFFLINE'&&r.observed_at>attempt.started_at);
  if(attempt&&attempt.as_of_state!=='RECORDED'&&!independentNewer){status=attempt.as_of_state==='FAILED'?'COLLECTION_FAILED':'COLLECTION_PENDING';value=null;reason=status==='COLLECTION_FAILED'?attempt.reason:'AWAITING_RECONCILIATION';}
  return {series_id:id,target,selector:shape,as_of:asOf,status,value,reason,observed_at:latest,collection_attempt:attempt,observation_ids:entries.map(x=>x.id),origin:target.origin,...flags};
 }
 async list(workspace,accountId,{cursor='',asOf=new Date().toISOString()}={}){
  await this.scope(workspace,accountId);if(cursor&&!/^[a-f0-9]{64}$/.test(cursor))fail('METRIC_CURSOR_INVALID');
  const rows=await this.rows('SELECT s.id FROM metric_series s JOIN metric_targets t ON t.id=s.target_id WHERE t.workspace=? AND t.account_id=? AND s.id>? ORDER BY s.id LIMIT 21',[workspace,accountId,cursor]),snapshots=[];
  for(const row of rows.slice(0,20))snapshots.push(await this.snapshot(row.id,{workspace,accountId,asOf}));return {snapshots,next_cursor:rows.length>20?rows[19].id:null,as_of:asOf,aggregation:'NOT_PERFORMED',...flags};
 }
 async history(id,{workspace,accountId,before=''}={}){
  const {target}=await this.seriesRow(id,workspace,accountId);if(before&&!/^[a-f0-9]{64}$/.test(before))fail('METRIC_CURSOR_INVALID');const rows=await this.rows('SELECT * FROM metric_observations WHERE series_id=? AND id>? ORDER BY id LIMIT 21',[id,before]),entries=[];
  for(const row of rows.slice(0,20))entries.push(await this.entry(row,target));return {entries,next_cursor:rows.length>20?rows[19].id:null,snapshot:await this.snapshot(id,{workspace,accountId})};
 }
}
