import {publishingPlatforms,guardedStates} from './publisher-platforms.js';

// Evidence diagnostics only. The existing executor and authenticated permits decide actions.
export const capabilityDimensions=Object.freeze({
 platform_support:'OFFICIAL_DOCUMENTATION',app_approval:'APP_REVIEW_RECORD',
 account_permission:'ACCOUNT_PERMISSION_READBACK',implementation:'CODE_REVIEW',
 runtime:'RUNTIME_PROBE',live_acceptance:'LIVE_ACCEPTANCE',policy:'POLICY_REVIEW',
});
const actions=new Set(['prepare','publish','readback','reply','react','insights','content_ingest']);
const scopeKeys=['workspace','account_id','platform','app_id','action','operation','transport','build_sha'];
const text=x=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=300;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const validScope=x=>exact(x,scopeKeys)&&scopeKeys.every(k=>text(x[k]))&&actions.has(x.action)&&/^[a-f0-9]{40}$/.test(x.build_sha)&&x.build_sha.length===40;
const timestamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const sameScope=(a,b)=>scopeKeys.every(k=>a[k]===b[k]);
export function diagnoseAccountCapability(input,{now=Date.now()}={}){
 if(!exact(input,['scope','frozen_scope','job_state','submit_safety_domain','evidence'])||!validScope(input.scope)||!validScope(input.frozen_scope)||!text(input.job_state)||!text(input.submit_safety_domain)||!Array.isArray(input.evidence)||!Number.isFinite(now))throw Error('INVALID_CAPABILITY_INPUT');
 const reasons=[],scope=input.scope;
 if(!sameScope(scope,input.frozen_scope))reasons.push('FROZEN_SCOPE_CHANGED');
 const platform=publishingPlatforms[scope.platform];
 if(!platform)reasons.push('LOCAL_PLATFORM_NOT_REGISTERED');
 else if(!platform.transports.includes(scope.transport))reasons.push('LOCAL_TRANSPORT_NOT_REGISTERED');
 if(['prepare','publish','reply','react'].includes(scope.action)&&(input.submit_safety_domain==='MAY_HAVE_SUBMITTED'||[...guardedStates,'RECONCILE_PENDING','SUBMITTED_PENDING_CONFIRMATION','DRAFT_API_WRITTEN_NOT_PUBLISHED'].includes(input.job_state)))reasons.push('EXISTING_OR_UNCERTAIN_RESULT_REQUIRES_READBACK');
 const facts={};
 for(const item of input.evidence){
  if(!exact(item,['dimension','status','scope','observed_at','valid_until','source'])||!Object.hasOwn(capabilityDimensions,item.dimension)||!['VERIFIED','UNSUPPORTED','DENIED','UNKNOWN','NOT_VERIFIED'].includes(item.status)||!validScope(item.scope)||!exact(item.source,['kind','reference'])||!text(item.source.reference))throw Error('INVALID_CAPABILITY_EVIDENCE');
  if(facts[item.dimension])throw Error('DUPLICATE_CAPABILITY_DIMENSION');
  const blockers=[];
  if(!sameScope(scope,item.scope))blockers.push('EVIDENCE_SCOPE_MISMATCH');
  if(item.source.kind!==capabilityDimensions[item.dimension])blockers.push('WRONG_EVIDENCE_SOURCE_KIND');
  if(item.dimension==='platform_support'){
   try{const url=new URL(item.source.reference);if(url.protocol!=='https:'||url.username||url.password)blockers.push('OFFICIAL_SOURCE_REFERENCE_REQUIRED');}catch{blockers.push('OFFICIAL_SOURCE_REFERENCE_REQUIRED');}
  }
  if(!timestamp(item.observed_at)||!timestamp(item.valid_until)||item.valid_until<=item.observed_at)blockers.push('INVALID_EVIDENCE_TIME');
  else if(Date.parse(item.observed_at)>now)blockers.push('FUTURE_EVIDENCE');
  else if(now>=Date.parse(item.valid_until))blockers.push('STALE_EVIDENCE');
  if(item.status!=='VERIFIED')blockers.push('EVIDENCE_'+item.status);
  facts[item.dimension]={reported_status:item.status,status:blockers.length?'BLOCKED':'VERIFIED_EVIDENCE',reasons:blockers};
 }
 for(const dimension of Object.keys(capabilityDimensions)){
  if(!facts[dimension])facts[dimension]={reported_status:'NOT_VERIFIED',status:'BLOCKED',reasons:['MISSING_EVIDENCE']};
  if(facts[dimension].status==='BLOCKED')reasons.push('DIMENSION_BLOCKED:'+dimension);
 }
 return {schema_version:1,advisory_only:true,can_execute:false,owner_changed:false,
  status:reasons.length?'BLOCKED':'EVIDENCE_COMPLETE',reasons,facts,
  local_registry:{platform_registered:Boolean(platform),transport_registered:Boolean(platform?.transports.includes(scope.transport)),publication_outcome:platform?.outcome??null},
  note:'Evidence labels and caller bindings are not authentication or authorization. Existing executor, permissions, confirmation and readback remain authoritative.'};
}
