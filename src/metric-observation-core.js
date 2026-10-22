// Pure evidence inspection: no database, network, collection or scheduling.
const fail=code=>{throw Error(code);};
const exact=(x,keys,code)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail(code);};
const text=x=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=1000;
const timestamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const availability=new Set(['AVAILABLE','UNAVAILABLE','NOT_SUPPORTED','PERMISSION_DENIED','INSUFFICIENT_DATA','NOT_COLLECTED']);
const metrics=new Set(['views','viewers','reach','impressions','engagements','link_clicks']);
const identityKeys=['operator_actor_id','business_asset_id','source_account_id','source_object_id'];
const recordKeys=['schema_version','workspace','account_id','platform','object_id','content_revision','publication_job_id','observed_at','source','window','metric','coverage','identity_evidence'];
export function validateMetricObservationCore(record,{binding,evidenceSha256,evidenceLength,now=Date.now()}={}){
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
 if(!['BROWSER_READBACK','API_READBACK','MANUAL_EXPORT'].includes(record.source.transport)||!text(record.source.reference)||!Number.isSafeInteger(evidenceLength)||evidenceLength<1||evidenceLength>5*1024*1024||!/^[a-f0-9]{64}$/.test(evidenceSha256||'')||record.source.sha256!==evidenceSha256)fail('SOURCE_HASH_MISMATCH');
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
 return observation;
}
