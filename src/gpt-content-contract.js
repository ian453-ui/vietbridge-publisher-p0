import {createHash} from 'node:crypto';

// A correlation/validation layer only. It never authenticates, claims, sends,
// persists, approves, imports, schedules or publishes a task.
const fail=code=>{throw Error(code);};
const exact=(value,keys,code)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail(code);
};
const text=(value,max=200)=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=max;
const id=value=>text(value,160)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const requestKeys=['schema_version','task_id','request_revision','current_owner','producer','workspace','account_id','source_id','content_revision','visual_revision','previous_revision','created_at','deadline_at','bridge_ref','input'];
const bridgeOwners=new Set(['GPT','MAC_CODEX','MAC_CLAUDE','MAC_WORKBUDDY','WINDOWS_CODEX','WINDOWS_CLAUDE','WINDOWS_WORKBUDDY','dot']);
function requestPayload(value){
 exact(value,requestKeys,'INVALID_REQUEST_SHAPE');
 if(value.schema_version!==1||!['task_id','current_owner','workspace','account_id'].every(k=>id(value[k]))||value.producer!=='GPT')fail('INVALID_REQUEST_BINDING');
 exact(value.bridge_ref,['marker','protocol_version','transport','slack_channel_id','thread_ts'],'INVALID_BRIDGE_REFERENCE');
 if(!bridgeOwners.has(value.current_owner)||value.bridge_ref.marker!=='bridge-task:v1'||value.bridge_ref.protocol_version!=='2.0'||value.bridge_ref.transport!=='SLACK_FIRST'||value.bridge_ref.slack_channel_id!=='C0C6PRGNGLQ'||!/^\d{10,}\.\d{6}$/.test(value.bridge_ref.thread_ts))fail('INVALID_BRIDGE_REFERENCE');
 if(!text(value.source_id,81)||!/^[A-Z][A-Z0-9-]{3,80}$/.test(value.source_id)||!['request_revision','content_revision','visual_revision'].every(k=>positive(value[k]))||value.previous_revision!==null&&!hash(value.previous_revision))fail('INVALID_REQUEST_VERSION');
 if(!time(value.created_at)||!time(value.deadline_at)||value.deadline_at<=value.created_at)fail('INVALID_REQUEST_DEADLINE');
 exact(value.input,['kind','platform','brief','language','source_refs'],'INVALID_INPUT_SHAPE');
 if(value.input.kind!=='image_text'||value.input.platform!=='facebook'||!text(value.input.brief,20000)||!text(value.input.language,40)||!Array.isArray(value.input.source_refs)||value.input.source_refs.length>100)fail('UNSUPPORTED_CONTENT_INPUT');
 for(const ref of value.input.source_refs){
  exact(ref,['source_id','revision','sha256'],'INVALID_SOURCE_REFERENCE');
  if(!id(ref.source_id)||!text(ref.revision,160)||!hash(ref.sha256))fail('INVALID_SOURCE_REFERENCE');
 }
 // Explicit field order makes fingerprints independent of JSON property order.
 return Object.fromEntries(requestKeys.map(k=>[k,k==='input'?{kind:value.input.kind,platform:value.input.platform,brief:value.input.brief,language:value.input.language,source_refs:value.input.source_refs.map(r=>({source_id:r.source_id,revision:r.revision,sha256:r.sha256}))}:k==='bridge_ref'?{marker:value.bridge_ref.marker,protocol_version:value.bridge_ref.protocol_version,transport:value.bridge_ref.transport,slack_channel_id:value.bridge_ref.slack_channel_id,thread_ts:value.bridge_ref.thread_ts}:value[k]]));
}
export function createGptContentRequest(input,{priorRequest=null}={}){
 const payload=requestPayload(input);
 const request={...payload,request_fingerprint:digest(payload),assignment_mode:'STICKY',handoff_policy:'USER_EXPLICIT_ONLY'};
 if(priorRequest!==null){
  const priorPayload=verifiedRequest(priorRequest);
  for(const key of ['task_id','current_owner','producer','workspace','account_id','source_id'])if(request[key]!==priorRequest[key])fail('REQUEST_IDENTITY_CHANGE');
  if(digest(request.bridge_ref)!==digest(priorPayload.bridge_ref))fail('REQUEST_THREAD_CHANGE');
  if(request.request_revision<priorRequest.request_revision)fail('STALE_REQUEST');
  if(request.request_revision===priorRequest.request_revision&&request.request_fingerprint!==priorRequest.request_fingerprint)fail('REQUEST_REVISION_CONFLICT');
 }
 return request;
}
function verifiedRequest(request){
 exact(request,[...requestKeys,'request_fingerprint','assignment_mode','handoff_policy'],'INVALID_REQUEST_ENVELOPE');
 const payload=requestPayload(Object.fromEntries(requestKeys.map(k=>[k,request[k]])));
 if(request.request_fingerprint!==digest(payload)||request.assignment_mode!=='STICKY'||request.handoff_policy!=='USER_EXPLICIT_ONLY')fail('REQUEST_FINGERPRINT_MISMATCH');
 return payload;
}
export function inspectGptContentResult(request,result,{now=Date.now(),priorReceipt=null}={}){
 verifiedRequest(request);
 if(!Number.isFinite(now)||now<Date.parse(request.created_at))fail('INVALID_INSPECTION_TIME');
 exact(result,['schema_version','task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id','source_id','content_revision','visual_revision','bridge_ref','completed_at','status','output','error_code'],'INVALID_RESULT_SHAPE');
 if(result.schema_version!==1)fail('UNSUPPORTED_RESULT_SCHEMA');
 for(const key of ['task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id','source_id','content_revision','visual_revision'])if(result[key]!==request[key])fail('RESULT_BINDING_MISMATCH');
 if(!result.bridge_ref||Object.keys(result.bridge_ref).length!==5||Object.keys(request.bridge_ref).some(k=>result.bridge_ref[k]!==request.bridge_ref[k]))fail('RESULT_THREAD_MISMATCH');
 if(!time(result.completed_at)||Date.parse(result.completed_at)<Date.parse(request.created_at)||Date.parse(result.completed_at)>now)fail('INVALID_RESULT_TIME');
 if(!['SUCCEEDED','FAILED','CANCELLED'].includes(result.status))fail('INVALID_RESULT_STATUS');
 let output=null;
 if(result.status==='SUCCEEDED'){
  if(result.error_code!==null)fail('INVALID_RESULT_ERROR');
  exact(result.output,['title','facebook_caption','primary_image_sha256'],'INVALID_OUTPUT_SHAPE');
  if(!text(result.output.title,200)||/[\r\n]/.test(result.output.title)||!text(result.output.facebook_caption,20000)||!hash(result.output.primary_image_sha256))fail('INVALID_RESULT_OUTPUT');
  output={title:result.output.title,facebook_caption:result.output.facebook_caption,primary_image_sha256:result.output.primary_image_sha256};
 }else if(result.output!==null||!id(result.error_code))fail('INVALID_FAILURE_RESULT');
 const resultFingerprint=digest([request.request_fingerprint,result.completed_at,result.status,output,result.error_code]);
 if(priorReceipt!==null){
  exact(priorReceipt,['request_fingerprint','result_fingerprint'],'INVALID_PRIOR_RECEIPT');
  if(priorReceipt.request_fingerprint!==request.request_fingerprint||priorReceipt.result_fingerprint!==resultFingerprint)fail('CONFLICTING_RESULT');
  return {status:'DUPLICATE',publish_allowed:false,receipt:{...priorReceipt}};
 }
 if(now>=Date.parse(request.deadline_at)||Date.parse(result.completed_at)>=Date.parse(request.deadline_at))fail('RESULT_EXPIRED');
 return {status:result.status==='SUCCEEDED'?'REVIEW_REQUIRED':result.status,publish_allowed:false,
  receipt:{request_fingerprint:request.request_fingerprint,result_fingerprint:resultFingerprint},
  ...(output?{output,content_sha256:digest([request.source_id,output.title,output.facebook_caption])}:{error_code:result.error_code})};
}

/** Bind only an already-read, account-scoped existing inbox candidate. No files are opened. */
export function bindGptResultToInbox(request,result,candidate,context,options={}){
 if(context?.workspace!==request.workspace||context?.account_id!==request.account_id)fail('INBOX_SCOPE_MISMATCH');
 const inspected=inspectGptContentResult(request,result,options);
 if(inspected.status!=='REVIEW_REQUIRED')fail('RESULT_NOT_REVIEWABLE');
 if(!candidate||!['PENDING_REVIEW','UPDATE_AVAILABLE'].includes(candidate.reviewStatus)||candidate.ready!==false)fail('INBOX_NOT_PENDING_REVIEW');
 if(candidate.articleId!==request.source_id||candidate.revisionNumber!==request.content_revision||candidate.visualRevision!==request.visual_revision||(candidate.previousRevision??null)!==request.previous_revision)fail('INBOX_VERSION_MISMATCH');
 if(!hash(candidate.key)||!hash(candidate.revision)||candidate.title!==inspected.output.title||candidate.body!==inspected.output.facebook_caption||candidate.assets?.length!==1||candidate.assets[0].sha256!==inspected.output.primary_image_sha256)fail('INBOX_OUTPUT_MISMATCH');
 return {task_id:request.task_id,request_fingerprint:request.request_fingerprint,receipt:inspected.receipt,status:'REVIEW_REQUIRED',publish_allowed:false,
  qa_binding:{inbox_key:candidate.key,inbox_revision:candidate.revision,previous_revision:request.previous_revision,content_sha256:inspected.content_sha256,image_sha256:inspected.output.primary_image_sha256,content_revision:request.content_revision,visual_revision:request.visual_revision},
  required_review:['CONTENT_FACTS','IMAGE_VISUAL_QA','EXISTING_USER_APPROVAL'],owner_changed:false};
}
