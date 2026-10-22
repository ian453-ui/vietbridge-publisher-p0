import {createHash} from 'node:crypto';
import {validateMetricObservationCore} from './metric-observation-core.js';

const fail=code=>{throw Error(code);};
const exact=(x,keys,code)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail(code);};
const timestamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const sha=x=>createHash('sha256').update(x).digest('hex');
export function validateMetricObservation(record,{binding,evidenceBytes,now=Date.now()}={}){
 const observation=validateMetricObservationCore(record,{binding,now,evidenceLength:Buffer.isBuffer(evidenceBytes)?evidenceBytes.length:0,evidenceSha256:Buffer.isBuffer(evidenceBytes)?sha(evidenceBytes):null});
 return {...observation,observation_id:sha(JSON.stringify(observation))};
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
