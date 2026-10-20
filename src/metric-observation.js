import {createHash} from 'node:crypto';

// Pure evidence inspection: no database, network, collection or scheduling.
const fail=code=>{throw Error(code);};
const exact=(x,keys,code)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail(code);};
const text=x=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=1000;
const timestamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const sha=x=>createHash('sha256').update(x).digest('hex');
const digest=x=>sha(JSON.stringify(x));
const availability=new Set(['AVAILABLE','UNAVAILABLE','NOT_SUPPORTED','PERMISSION_DENIED','INSUFFICIENT_DATA','NOT_COLLECTED']);
const metrics=new Set(['views','viewers','reach','impressions','engagements','link_clicks']);
const identityKeys=['operator_actor_id','business_asset_id','source_account_id','source_object_id'];
const recordKeys=['schema_version','workspace','account_id','platform','object_id','content_revision','publication_job_id','observed_at','source','window','metric','coverage','identity_evidence'];
export function validateMetricObservation(record,{binding,evidenceBytes,now=Date.now()}={}){
 exact(record,recordKeys,'INVALID_OBSERVATION_SHAPE');
 if(record.schema_version!==1||!Number.isFinite(now)||!timestamp(record.observed_at)||Date.parse(record.observed_at)>now)fail('INVALID_OBSERVATION_TIME_OR_VERSION');
 for(const k of ['workspace','account_id','platform','object_id','content_revision','publication_job_id'])if(!text(record[k]))fail('INVALID_OBSERVATION_BINDING');
 exact(binding,['workspace','account_id','platform','object_id','content_revision','publication_job_id','source_reference','source_transport',...identityKeys],'INVALID_EXPECTED_BINDING');
 for(const k of ['workspace','account_id','platform','object_id','content_revision','publication_job_id'])if(binding[k]!==record[k])fail('OBSERVATION_SCOPE_MISMATCH');
 exact(record.identity_evidence,[...identityKeys,'verified_at','method','reference'],'INVALID_IDENTITY_EVIDENCE');
 for(const k of identityKeys)if(!text(binding[k])||record.identity_evidence[k]!==binding[k])fail('IDENTITY_MISMATCH');
 if(binding.source_object_id!==record.object_id||!timestamp(record.identity_evidence.verified_at)||Date.parse(record.identity_evidence.verified_at)>Date.parse(record.observed_at)||!['AUTHENTICATED_UI','AUTHENTICATED_API','MANUAL_REVIEW'].includes(record.identity_evidence.method)||!text(record.identity_evidence.reference))fail('INVALID_IDENTITY_EVIDENCE');
 exact(record.source,['transport','reference','sha256'],'INVALID_SOURCE');
 if(record.source.reference!==binding.source_reference||record.source.transport!==binding.source_transport)fail('SOURCE_BINDING_MISMATCH');
 if(!['BROWSER_READBACK','API_READBACK','MANUAL_EXPORT'].includes(record.source.transport)||!text(record.source.reference)||!Buffer.isBuffer(evidenceBytes)||evidenceBytes.length===0||evidenceBytes.length>5*1024*1024||record.source.sha256!==sha(evidenceBytes))fail('SOURCE_HASH_MISMATCH');
 exact(record.window,['kind','start','end','timezone'],'INVALID_WINDOW');
 const w=record.window;
 if(w.kind==='UNKNOWN'){
  if(w.start!==null||w.end!==null||w.timezone!==null)fail('UNKNOWN_WINDOW_MUST_STAY_UNKNOWN');
 }else{
  if(w.kind!=='BOUNDED'||!timestamp(w.start)||!timestamp(w.end)||w.start>=w.end||Date.parse(w.end)>Date.parse(record.observed_at))fail('INVALID_WINDOW');
  if(w.timezone!==null){try{if(!text(w.timezone))fail('INVALID_WINDOW');new Intl.DateTimeFormat('en',{timeZone:w.timezone});}catch{fail('INVALID_WINDOW_TIMEZONE');}}
 }
 exact(record.metric,['name','definition_id','definition_version','definition_text','value','unit','availability'],'INVALID_METRIC');
 const m=record.metric;
 if(!metrics.has(m.name)||!text(m.definition_id)||!text(m.definition_version)||!text(m.definition_text)||m.unit!=='count'||!availability.has(m.availability))fail('INVALID_METRIC_DEFINITION');
 if(m.availability==='AVAILABLE'?!Number.isSafeInteger(m.value)||m.value<0:m.value!==null)fail('METRIC_VALUE_AVAILABILITY_MISMATCH');
 exact(record.coverage,['scope','completeness'],'INVALID_COVERAGE');
 if(record.coverage.scope!=='OBJECT'||!['COMPLETE','PARTIAL','UNKNOWN'].includes(record.coverage.completeness))fail('INVALID_COVERAGE');
 // Canonical nested order; cloned data prevents callers mutating the input via output.
 const observation={...Object.fromEntries(recordKeys.slice(0,8).map(k=>[k,record[k]])),
  source:{transport:record.source.transport,reference:record.source.reference,sha256:record.source.sha256},
  window:{kind:w.kind,start:w.start,end:w.end,timezone:w.timezone},
  metric:Object.fromEntries(['name','definition_id','definition_version','definition_text','value','unit','availability'].map(k=>[k,m[k]])),
  coverage:{scope:record.coverage.scope,completeness:record.coverage.completeness},
  identity_evidence:Object.fromEntries([...identityKeys,'verified_at','method','reference'].map(k=>[k,record.identity_evidence[k]]))};
 return {...observation,observation_id:digest(observation)};
}
const definition=o=>[o.metric.name,o.metric.definition_id,o.metric.definition_version,o.metric.definition_text,o.metric.unit];
const target=o=>[o.identity_evidence.source_account_id,o.identity_evidence.business_asset_id];
const series=o=>JSON.stringify([o.workspace,o.account_id,o.platform,target(o),o.object_id,o.content_revision,o.publication_job_id,definition(o),o.window]);

/** Revalidates supplied entries; preserves every distinct observation and selects latest as-of. */
export function inspectMetricEvidence(entries,{now=Date.now(),asOf=new Date(now).toISOString()}={}){
 if(!Array.isArray(entries)||!Number.isFinite(now)||!timestamp(asOf)||Date.parse(asOf)>now)fail('INVALID_AS_OF');
 const unique=new Map(),slots=new Map();let duplicates=0;
 for(const entry of entries){
  exact(entry,['observation','binding','evidenceBytes'],'INVALID_EVIDENCE_ENTRY');
  const o=validateMetricObservation(entry.observation,{binding:entry.binding,evidenceBytes:entry.evidenceBytes,now});
  const slot=series(o)+'|'+o.observed_at;
  if(slots.has(slot)&&slots.get(slot)!==o.observation_id)fail('CONFLICTING_AS_OF_SNAPSHOT');
  slots.set(slot,o.observation_id);
  if(unique.has(o.observation_id)){duplicates++;continue;}unique.set(o.observation_id,o);
 }
 const observations=[...unique.values()].sort((a,b)=>a.observed_at.localeCompare(b.observed_at)||a.observation_id.localeCompare(b.observation_id));
 const latest=new Map();for(const o of observations)if(o.observed_at<=asOf)latest.set(series(o),o);
 return {schema_version:1,as_of:asOf,duplicates,observations,snapshots:[...latest.values()]};
}

/** Counts only; never sums cross-platform definitions or unique-audience counts. */
export function aggregateMetricEvidence(entries,options={}){
 const report=inspectMetricEvidence(entries,options),rows=report.snapshots,reasons=[];
 if(!rows.length)return {status:'NOT_AGGREGATED',value:null,reasons:['NO_OBSERVATIONS_AS_OF'],report};
 const first=rows[0],group=o=>JSON.stringify([o.workspace,o.account_id,o.platform,target(o),definition(o),o.window]);
 if(rows.some(o=>group(o)!==group(first)))reasons.push('INCOMPATIBLE_DEFINITION_OR_WINDOW_OR_SCOPE_OR_TARGET');
 if(rows.some(o=>o.window.kind==='UNKNOWN'||o.window.timezone===null))reasons.push('WINDOW_OR_TIMEZONE_UNKNOWN');
 if(rows.some(o=>o.metric.availability!=='AVAILABLE'))reasons.push('UNAVAILABLE_VALUES');
 if(rows.some(o=>o.coverage.completeness!=='COMPLETE'))reasons.push('INCOMPLETE_COVERAGE');
 if(rows.some(o=>['viewers','reach'].includes(o.metric.name)))reasons.push('NON_ADDITIVE_AUDIENCE');
 if(new Set(rows.map(o=>o.object_id)).size!==rows.length)reasons.push('OVERLAPPING_OBJECT_REVISIONS');
 if(reasons.length)return {status:'NOT_AGGREGATED',value:null,reasons,report};
 const value=rows.reduce((sum,o)=>sum+o.metric.value,0);if(!Number.isSafeInteger(value))fail('AGGREGATE_OVERFLOW');
 return {status:'AGGREGATED',coverage:'OBSERVED_OBJECTS_ONLY',value,unit:first.metric.unit,metric_name:first.metric.name,object_count:rows.length,as_of:report.as_of,observation_ids:rows.map(o=>o.observation_id),report};
}
