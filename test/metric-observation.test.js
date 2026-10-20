import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateMetricObservation,inspectMetricEvidence,aggregateMetricEvidence} from '../src/metric-observation.js';
const now=Date.parse('2026-10-20T12:00:00.000Z');
function fixture(object='post-fixture-1',value=100,observed='2026-10-20T11:00:00.000Z'){
 const evidenceBytes=Buffer.from(JSON.stringify({synthetic:true,object,value,observed})),reference='fixture://'+object+'/'+observed;
 const binding={workspace:'workspace-fixture',account_id:'account-fixture',platform:'facebook',object_id:object,content_revision:'r1',publication_job_id:'job-'+object,source_reference:reference,source_transport:'BROWSER_READBACK',operator_actor_id:'actor-fixture',business_asset_id:'asset-fixture',source_account_id:'profile-fixture',source_object_id:object};
 const observation={schema_version:1,workspace:binding.workspace,account_id:binding.account_id,platform:binding.platform,object_id:object,content_revision:'r1',publication_job_id:'job-'+object,observed_at:observed,
  source:{transport:binding.source_transport,reference,sha256:createHash('sha256').update(evidenceBytes).digest('hex')},
  window:{kind:'BOUNDED',start:'2026-10-19T00:00:00.000Z',end:'2026-10-20T00:00:00.000Z',timezone:'UTC'},
  metric:{name:'views',definition_id:'fixture-views',definition_version:'v1',definition_text:'Synthetic count of object views; repeated views counted.',value,unit:'count',availability:'AVAILABLE'},
  coverage:{scope:'OBJECT',completeness:'COMPLETE'},identity_evidence:{operator_actor_id:binding.operator_actor_id,business_asset_id:binding.business_asset_id,source_account_id:binding.source_account_id,source_object_id:object,verified_at:'2026-10-20T10:00:00.000Z',method:'MANUAL_REVIEW',reference:'fixture-identity-proof'}};
 return {observation,binding,evidenceBytes};
}
const validate=x=>validateMetricObservation(x.observation,{binding:x.binding,evidenceBytes:x.evidenceBytes,now});
test('actor, business asset and source account stay distinct and evidence is immutable',()=>{
 const x=fixture(),before=JSON.stringify(x);const checked=validate(x);assert.notEqual(checked.identity_evidence.operator_actor_id,checked.identity_evidence.business_asset_id);assert.equal(JSON.stringify(x),before);
 checked.metric.value=999;assert.equal(x.observation.metric.value,100);
});
test('missing metrics stay null and every unavailable status rejects invented zero',()=>{
 for(const availability of ['UNAVAILABLE','NOT_SUPPORTED','PERMISSION_DENIED','INSUFFICIENT_DATA','NOT_COLLECTED']){
  const x=fixture();x.observation.metric.availability=availability;x.observation.metric.value=null;assert.equal(validate(x).metric.value,null);
  assert.equal(aggregateMetricEvidence([x],{now}).status,'NOT_AGGREGATED');x.observation.metric.value=0;assert.throws(()=>validate(x),/METRIC_VALUE_AVAILABILITY_MISMATCH/);
 }
 const x=fixture();x.observation.metric.value=null;assert.throws(()=>validate(x),/METRIC_VALUE_AVAILABILITY_MISMATCH/);
});
test('unknown window or timezone is preserved without guesses and never aggregated',()=>{
 const x=fixture();x.observation.window={kind:'UNKNOWN',start:null,end:null,timezone:null};assert.equal(validate(x).window.timezone,null);assert.equal(aggregateMetricEvidence([x],{now}).value,null);
 x.observation.window.start='2026-10-19T00:00:00.000Z';assert.throws(()=>validate(x),/UNKNOWN_WINDOW_MUST_STAY_UNKNOWN/);
 const y=fixture();y.observation.window.timezone=null;assert.ok(aggregateMetricEvidence([y],{now}).reasons.includes('WINDOW_OR_TIMEZONE_UNKNOWN'));
});
test('source/account/object mismatches and altered raw evidence reject',()=>{
 for(const field of ['workspace','account_id','platform','object_id']){const x=fixture();x.observation[field]='other';assert.throws(()=>validate(x),/OBSERVATION_SCOPE_MISMATCH/);}
 for(const field of ['operator_actor_id','business_asset_id','source_account_id','source_object_id']){const x=fixture();x.observation.identity_evidence[field]='other';assert.throws(()=>validate(x),/IDENTITY_MISMATCH/);}
 const x=fixture();x.evidenceBytes=Buffer.from('other synthetic source');assert.throws(()=>validate(x),/SOURCE_HASH_MISMATCH/);
 const y=fixture();y.observation.source.reference='fixture://other';assert.throws(()=>validate(y),/SOURCE_BINDING_MISMATCH/);
});
test('invalid or future observation/window/identity/as-of times reject',()=>{
 for(const change of [x=>x.observation.observed_at='invalid',x=>x.observation.observed_at='2026-10-20T13:00:00.000Z',x=>x.observation.window.end='2026-10-20T12:00:00.000Z',x=>x.observation.window.timezone='Invalid/Zone',x=>x.observation.identity_evidence.verified_at='2026-10-20T11:30:00.000Z']){const x=fixture();change(x);assert.throws(()=>validate(x));}
 assert.throws(()=>inspectMetricEvidence([fixture()],{now,asOf:'2026-10-21T00:00:00.000Z'}),/INVALID_AS_OF/);
});
test('exact duplicate is idempotent, conflicting same-time snapshot rejects',()=>{
 const x=fixture(),report=inspectMetricEvidence([x,x],{now});assert.equal(report.duplicates,1);assert.equal(report.observations.length,1);assert.equal(report.snapshots.length,1);
 const y=fixture();y.observation.metric.value=90;assert.throws(()=>inspectMetricEvidence([x,y],{now}),/CONFLICTING_AS_OF_SNAPSHOT/);
});
test('later downward revisions preserve history and as-of selection, not max or sum',()=>{
 const old=fixture('post-fixture-1',100),next=fixture('post-fixture-1',80,'2026-10-20T11:30:00.000Z');
 const report=inspectMetricEvidence([next,old],{now});assert.equal(report.observations.length,2);assert.equal(report.snapshots[0].metric.value,80);
 assert.equal(inspectMetricEvidence([old,next],{now,asOf:'2026-10-20T11:10:00.000Z'}).snapshots[0].metric.value,100);
 assert.equal(aggregateMetricEvidence([old,next],{now}).value,80);
});
test('only comparable complete occurrence counts aggregate; audience, definition and window mismatches do not',()=>{
 const first=fixture(),second=fixture('post-fixture-2',20);assert.equal(aggregateMetricEvidence([first,second],{now}).value,120);
 for(const change of [x=>x.observation.metric.name='impressions',x=>x.observation.metric.definition_version='v2',x=>x.observation.metric.definition_text='Different meaning',x=>x.observation.window.start='2026-10-18T00:00:00.000Z',x=>x.observation.coverage.completeness='PARTIAL']){const x=fixture('post-fixture-2',20);change(x);assert.equal(aggregateMetricEvidence([first,x],{now}).value,null);}
 for(const name of ['viewers','reach']){const x=fixture();x.observation.metric.name=name;assert.ok(aggregateMetricEvidence([x],{now}).reasons.includes('NON_ADDITIVE_AUDIENCE'));}
 const revised=fixture();revised.observation.content_revision='r2';revised.binding.content_revision='r2';assert.ok(aggregateMetricEvidence([first,revised],{now}).reasons.includes('OVERLAPPING_OBJECT_REVISIONS'));
});

test('available zero is distinct from missing; invalid counts and aggregate overflow reject',()=>{
 const zero=fixture('zero-fixture',0);assert.equal(validate(zero).metric.value,0);assert.equal(aggregateMetricEvidence([zero],{now}).value,0);
 for(const value of [-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'100']){const x=fixture();x.observation.metric.value=value;assert.throws(()=>validate(x),/METRIC_VALUE_AVAILABILITY_MISMATCH/);}
 assert.throws(()=>aggregateMetricEvidence([fixture('large-1',Number.MAX_SAFE_INTEGER),fixture('large-2',1)],{now}),/AGGREGATE_OVERFLOW/);
});
test('cross-account/platform observations and unavailable newer snapshots cannot produce a misleading total',()=>{
 const first=fixture();
 for(const field of ['workspace','account_id','platform']){const second=fixture('other-post',20);second.binding[field]='other';second.observation[field]='other';assert.equal(aggregateMetricEvidence([first,second],{now}).value,null);}
 const later=fixture('post-fixture-1',0,'2026-10-20T11:30:00.000Z');later.observation.metric.availability='UNAVAILABLE';later.observation.metric.value=null;
 const r=aggregateMetricEvidence([first,later],{now});assert.equal(r.value,null);assert.equal(r.report.snapshots[0].metric.availability,'UNAVAILABLE');assert.equal(r.report.observations.length,2);
});


test('same local account cannot aggregate distinct real target identities; snapshots remain separate',()=>{
 const first=fixture('post-1',7),second=fixture('post-2',5);
 for(const key of ['source_account_id','business_asset_id']){
  const other=fixture('post-2',5);other.binding[key]='other-'+key;other.observation.identity_evidence[key]=other.binding[key];
  const r=aggregateMetricEvidence([first,other],{now});assert.equal(r.value,null);assert.equal(r.report.observations.length,2);assert.equal(r.report.snapshots.length,2);
 }
 second.binding.operator_actor_id='other-operator';second.observation.identity_evidence.operator_actor_id='other-operator';
 assert.equal(aggregateMetricEvidence([first,second],{now}).value,12,'operator may differ while the exact target remains the same');
 const sameObject=fixture('post-1',5);sameObject.binding.source_account_id='other-source';sameObject.observation.identity_evidence.source_account_id='other-source';
 assert.equal(inspectMetricEvidence([first,sameObject],{now}).snapshots.length,2);
});
test('publication job and content revision require exact independently supplied expected mapping',()=>{
 for(const key of ['content_revision','publication_job_id']){
  const x=fixture();x.observation[key]='invented';assert.throws(()=>validate(x),/OBSERVATION_SCOPE_MISMATCH/);
  const y=fixture();delete y.binding[key];assert.throws(()=>validate(y),/INVALID_EXPECTED_BINDING/);
 }
});
