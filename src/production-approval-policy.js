// Shared native/async content-decision policy; never grants publication authority.
const fail=code=>{throw Error(code);};
const exact=(x,keys)=>{if(!x||Array.isArray(x)||typeof x!=='object'||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail('APPROVAL_COMMAND_INVALID');};
export const productionReviewChecks=Object.freeze(['CONTENT_FACTS','VISUAL_QA','VIDEO_PLAYBACK_AND_SUBTITLE_ALIGNMENT','ORIGINAL_SOURCE_REVIEW']);
export function requireProductionAdmin(authority){if(authority?.kind!=='EXISTING_ADMIN'||!/^admin:[a-f0-9]{64}$/.test(authority.actor_id||''))fail('APPROVAL_ADMIN_REQUIRED');}
export function validateProductionDecision(input){
 exact(input,['command_id','decision','expected_subject','expected_event_id','reason','checks','confirmation']);exact(input.checks,productionReviewChecks);
  if(!/^[a-f0-9-]{36}$/.test(input.command_id||'')||!['APPROVE','REJECT'].includes(input.decision)||!/^([a-f0-9]{64})$/.test(input.expected_subject||'')||input.expected_event_id!==null&&!/^[a-f0-9-]{36}$/.test(input.expected_event_id)||typeof input.reason!=='string'||input.reason.trim()!==input.reason||input.reason.length>1000||input.decision==='REJECT'&&!input.reason||productionReviewChecks.some(k=>typeof input.checks[k]!=='boolean')||input.confirmation!=='CONTENT_ONLY')fail('APPROVAL_COMMAND_INVALID');
  if(input.decision==='APPROVE'&&productionReviewChecks.some(k=>!input.checks[k]))fail('APPROVAL_CHECKLIST_REQUIRED');
}
export const approvalIdentityFields=Object.freeze(['id','workspace','platform','external_id','operator_actor_id','target_page_id','identity_type','expected_identity','profile_id','publisher_transport','publisher_options_json','enabled']);
