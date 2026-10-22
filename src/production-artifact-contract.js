import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {resolve,relative,isAbsolute,extname,sep} from 'node:path';
import {validateGptTaskIdentity} from './gpt-content-contract.js';
import {validateImage} from './image-validation.js';
import {validateVideo} from './video-validation.js';

const fail=code=>{throw Error(code);};
const exact=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail('INVALID_PRODUCTION_SHAPE');};
const text=(x,max=160)=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=max;
const id=x=>text(x)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(x);
const hash=x=>typeof x==='string'&&x.length===64&&/^[a-f0-9]{64}$/.test(x);
const positive=x=>Number.isSafeInteger(x)&&x>0;
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const bytesHash=x=>createHash('sha256').update(x).digest('hex');
const kinds=new Set(['knowledge_article','script','subtitle','video','cover','platform_payload']);
const requestKeys=['schema_version','mode','task_id','request_revision','current_owner','producer','workspace','account_id','bridge_ref','created_at','deadline_at','items'];
const itemKeys=['source_id','content_revision','visual_revision','previous_revision','brief','source_refs','deliverables'];
const specKeys=['artifact_id','kind','language','platform','references'];
const refKeys=['artifact_id','sha256'];
const bindingKeys=['source_id','content_revision','visual_revision','previous_revision','item_fingerprint'];
const resultKeys=['schema_version','mode','task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id','bridge_ref','completed_at','items'];
function payload(input){
 exact(input,requestKeys);validateGptTaskIdentity(input);
 if(input.schema_version!==2||input.mode!=='PRODUCTION_ARTIFACTS'||!positive(input.request_revision))fail('INVALID_PRODUCTION_VERSION');
 if(![input.workspace,input.account_id].every(x=>x===null||id(x))||input.workspace===null&&input.account_id!==null)fail('INVALID_PRODUCTION_SCOPE');
 if(!time(input.created_at)||!time(input.deadline_at)||input.deadline_at<=input.created_at)fail('INVALID_REQUEST_DEADLINE');
 if(!Array.isArray(input.items)||input.items.length<1||input.items.length>50)fail('INVALID_PRODUCTION_ITEMS');
 const sources=new Set();
 for(const item of input.items){
  exact(item,itemKeys);
  if(!text(item.source_id,81)||!/^[A-Z][A-Z0-9-]{3,80}$/.test(item.source_id)||sources.has(item.source_id))fail('INVALID_OR_DUPLICATE_SOURCE');sources.add(item.source_id);
  if(!positive(item.content_revision)||!positive(item.visual_revision)||item.previous_revision!==null&&!hash(item.previous_revision)||!text(item.brief,20000))fail('INVALID_ITEM_VERSION');
  if(!Array.isArray(item.source_refs)||item.source_refs.length>100)fail('INVALID_SOURCE_REFERENCE');
  for(const ref of item.source_refs){exact(ref,['source_id','revision','sha256']);if(!id(ref.source_id)||!text(ref.revision)||!hash(ref.sha256))fail('INVALID_SOURCE_REFERENCE');}
  if(!Array.isArray(item.deliverables)||!item.deliverables.length||item.deliverables.length>30)fail('INVALID_DELIVERABLES');
  const ids=new Set();for(const spec of item.deliverables){exact(spec,specKeys);if(!id(spec.artifact_id)||ids.has(spec.artifact_id)||!kinds.has(spec.kind)||!text(spec.language,40))fail('INVALID_OR_DUPLICATE_ARTIFACT');ids.add(spec.artifact_id);
   if(spec.kind==='platform_payload'?!id(spec.platform):spec.platform!==null)fail('INVALID_ARTIFACT_PLATFORM');
   if(!Array.isArray(spec.references)||spec.references.some(x=>!id(x))||new Set(spec.references).size!==spec.references.length)fail('INVALID_ARTIFACT_REFERENCES');
  }
  for(const spec of item.deliverables)if(spec.references.some(x=>!ids.has(x)||x===spec.artifact_id)||spec.kind==='platform_payload'&&!spec.references.length)fail('INVALID_ARTIFACT_REFERENCES');
 }
 return canonical(input);
}
export function createProductionRequest(input,{priorRequest=null}={}){
 const p=payload(input),request={...p,request_fingerprint:digest(p),assignment_mode:'STICKY',handoff_policy:'USER_EXPLICIT_ONLY'};
 if(priorRequest){verifyProductionRequest(priorRequest);
  for(const k of ['task_id','current_owner','producer','workspace','account_id'])if(request[k]!==priorRequest[k])fail('REQUEST_IDENTITY_CHANGE');
  if(digest(request.bridge_ref)!==digest(priorRequest.bridge_ref))fail('REQUEST_THREAD_CHANGE');
  if(request.request_revision<priorRequest.request_revision)fail('STALE_REQUEST');
  if(request.request_revision===priorRequest.request_revision&&request.request_fingerprint!==priorRequest.request_fingerprint)fail('REQUEST_REVISION_CONFLICT');
  for(const old of priorRequest.items){const next=request.items.find(x=>x.source_id===old.source_id);if(!next)fail('ITEM_REMOVAL_REQUIRES_SEPARATE_REVIEW');
   if(next.content_revision<old.content_revision||next.visual_revision<old.visual_revision)fail('STALE_ITEM_VERSION');
   if(digest(next)!==digest(old)&&(next.content_revision===old.content_revision&&next.visual_revision===old.visual_revision||next.previous_revision!==digest(old)))fail('ITEM_REVISION_CONFLICT');
  }
 }
 return request;
}
export function verifyProductionRequest(request){
 exact(request,[...requestKeys,'request_fingerprint','assignment_mode','handoff_policy']);
 const p=payload(Object.fromEntries(requestKeys.map(k=>[k,request[k]])));
 if(digest(p)!==request.request_fingerprint||request.assignment_mode!=='STICKY'||request.handoff_policy!=='USER_EXPLICIT_ONLY')fail('REQUEST_FINGERPRINT_MISMATCH');return request;
}
export const productionItemFingerprint=item=>digest(item);
export function readProductionArtifact(root,path,kind,{includeBytes=false}={}){
 if(!text(path,500)||isAbsolute(path)||path.includes('\\')||path.split('/').some(x=>!x||x==='.'||x==='..'))fail('INVALID_ARTIFACT_PATH');
 const base=realpathSync(root),file=realpathSync(resolve(base,path)),rel=relative(base,file);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!statSync(base).isDirectory())fail('ARTIFACT_PATH_ESCAPE');
 const max=kind==='video'?100*1024*1024:['cover'].includes(kind)?20000000:1024*1024;
 const fd=openSync(file,constants.O_RDONLY|constants.O_NONBLOCK);let stat,bytes;
 try{
  stat=fstatSync(fd,{bigint:true});
  if(!stat.isFile()||stat.size<1||stat.size>max)fail('INVALID_ARTIFACT_SIZE');
  bytes=readFileSync(fd);
 }finally{closeSync(fd);}
 if(bytes.length<1||bytes.length>max)fail('INVALID_ARTIFACT_SIZE');
 const ext=extname(file).toLowerCase();let validation;
 if(kind==='cover'){validation={level:'IMAGE_DECODED',...validateImage(bytes,ext)};}
 else if(kind==='video'){if(!['.mp4','.mov','.webm'].includes(ext))fail('INVALID_VIDEO_EXTENSION');validation=validateVideo(bytes,ext);}
 else{
  if(!({knowledge_article:['.md'],script:['.md','.txt'],subtitle:['.srt'],platform_payload:['.md','.txt']}[kind]||[]).includes(ext))fail('INVALID_TEXT_EXTENSION');
  let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('INVALID_UTF_EIGHT');}
  if(!content.trim()||content.includes('\0'))fail('INVALID_TEXT_CONTENT');
  if(kind==='subtitle'){
   const blocks=content.trim().replace(/\r\n/g,'\n').split(/\n\s*\n/);let previousStart=-1;
   for(const [i,block] of blocks.entries()){
    const lines=block.split('\n'),m=lines[1]?.match(/^(\d{2}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2}):([0-5]\d):([0-5]\d),(\d{3})$/);
    if(lines[0]!==String(i+1)||!m||!lines.slice(2).join('\n').trim())fail('INVALID_SUBTITLE_STRUCTURE');
    const ms=offset=>(Number(m[offset])*3600+Number(m[offset+1])*60+Number(m[offset+2]))*1000+Number(m[offset+3]);const start=ms(1),end=ms(5);
    if(start<previousStart||end<=start)fail('INVALID_SUBTITLE_TIMING');previousStart=start;
   }
   validation={level:'SRT_SYNTAX_VALIDATED',cue_count:blocks.length,video_alignment_verified:false};
  }else validation={level:'UTF8_TEXT_VALIDATED',facts_verified:false};
 }
 return {sha256:bytesHash(bytes),bytes:bytes.length,validation,fileIdentity:`${stat.dev}:${stat.ino}`,...(includeBytes?{data:bytes,extension:ext}:{})};
}
const localArtifact=readProductionArtifact;
const flags={publish_allowed:false,import_allowed:false,owner_changed:false,producer_authenticated:false};
export function inspectProductionResult(request,result,{root,now=Date.now(),priorReceipt=null}={}){
 verifyProductionRequest(request);exact(result,resultKeys);
 if(!Number.isFinite(now)||now<Date.parse(request.created_at))fail('INVALID_INSPECTION_TIME');
 for(const k of ['schema_version','mode','task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id'])if(result[k]!==request[k])fail('RESULT_BINDING_MISMATCH');
 if(digest(result.bridge_ref)!==digest(request.bridge_ref))fail('RESULT_THREAD_MISMATCH');
 if(!time(result.completed_at)||Date.parse(result.completed_at)<Date.parse(request.created_at)||Date.parse(result.completed_at)>now)fail('INVALID_RESULT_TIME');
 if(!Array.isArray(result.items)||result.items.length!==request.items.length)fail('RESULT_ITEMS_MISSING_OR_EXTRA');
 const seen=new Set(),fileIdentities=new Set(),checked=[];
 for(const row of result.items){exact(row,[...bindingKeys,'artifacts']);const item=request.items.find(x=>x.source_id===row.source_id);
  if(!item||seen.has(row.source_id))fail('RESULT_ITEM_IDENTITY_MISMATCH');seen.add(row.source_id);
  for(const k of ['content_revision','visual_revision','previous_revision'])if(row[k]!==item[k])fail('RESULT_ITEM_VERSION_MISMATCH');
  if(row.item_fingerprint!==digest(item))fail('RESULT_ITEM_FINGERPRINT_MISMATCH');
  if(!Array.isArray(row.artifacts)||row.artifacts.length!==item.deliverables.length)fail('RESULT_ARTIFACTS_MISSING_OR_EXTRA');
  const artifactIds=new Set(),artifacts=[];
  for(const artifact of row.artifacts){exact(artifact,['artifact_id','path','sha256','references']);const spec=item.deliverables.find(x=>x.artifact_id===artifact.artifact_id);
   if(!spec||artifactIds.has(artifact.artifact_id)||!hash(artifact.sha256))fail('INVALID_RESULT_ARTIFACT');artifactIds.add(artifact.artifact_id);
   if(!Array.isArray(artifact.references)||artifact.references.length!==spec.references.length)fail('RESULT_REFERENCE_MISMATCH');
   const refs=new Set();for(const ref of artifact.references){exact(ref,refKeys);const target=row.artifacts.find(x=>x.artifact_id===ref.artifact_id);if(!spec.references.includes(ref.artifact_id)||refs.has(ref.artifact_id)||!target||ref.sha256!==target.sha256)fail('RESULT_REFERENCE_MISMATCH');refs.add(ref.artifact_id);}
   const {fileIdentity,...actual}=localArtifact(root,artifact.path,spec.kind);
   if(fileIdentities.has(fileIdentity))fail('ARTIFACT_FILE_REUSED');fileIdentities.add(fileIdentity);
   if(actual.sha256!==artifact.sha256)fail('ARTIFACT_HASH_MISMATCH');
   artifacts.push({artifact_id:spec.artifact_id,kind:spec.kind,platform:spec.platform,...actual});
  }
  checked.push({source_id:item.source_id,content_revision:item.content_revision,visual_revision:item.visual_revision,item_fingerprint:digest(item),artifacts});
 }
 const receipt={request_fingerprint:request.request_fingerprint,result_fingerprint:digest(result)};
 if(priorReceipt!==null){exact(priorReceipt,['request_fingerprint','result_fingerprint']);if(digest(receipt)!==digest(priorReceipt))fail('CONFLICTING_RESULT');return {status:'DUPLICATE',...flags,receipt};}
 if(now>=Date.parse(request.deadline_at)||Date.parse(result.completed_at)>=Date.parse(request.deadline_at))fail('RESULT_EXPIRED');
 return {status:'REVIEW_REQUIRED',structure:'VALIDATED',...flags,scope_status:request.workspace===null||request.account_id===null?'UNKNOWN':'CALLER_DECLARED',receipt,items:checked,required_review:['CONTENT_FACTS','VISUAL_QA','VIDEO_PLAYBACK_AND_SUBTITLE_ALIGNMENT','ORIGINAL_SOURCE_REVIEW']};
}
/** Explicit local packaging only; binds supplied bytes, never authenticates a producer. */
export function packageProductionResult(request,selections,{root,now=Date.now()}={}){
 verifyProductionRequest(request);if(!Array.isArray(selections)||selections.length!==request.items.length)fail('INVALID_SELECTIONS');
 const ids=new Set(),items=selections.map(row=>{exact(row,['source_id','files']);const item=request.items.find(x=>x.source_id===row.source_id);if(!item||ids.has(row.source_id))fail('INVALID_SELECTIONS');ids.add(row.source_id);
  if(!Array.isArray(row.files)||row.files.length!==item.deliverables.length)fail('INVALID_SELECTIONS');
  const artifacts=row.files.map(file=>{exact(file,['artifact_id','path']);const spec=item.deliverables.find(x=>x.artifact_id===file.artifact_id);if(!spec)fail('INVALID_SELECTIONS');return {artifact_id:file.artifact_id,path:file.path,sha256:localArtifact(root,file.path,spec.kind).sha256,references:[]};});
  for(const artifact of artifacts){const spec=item.deliverables.find(x=>x.artifact_id===artifact.artifact_id);artifact.references=spec.references.map(artifact_id=>({artifact_id,sha256:artifacts.find(x=>x.artifact_id===artifact_id)?.sha256}));}
  return {...Object.fromEntries(bindingKeys.filter(k=>k!=='item_fingerprint').map(k=>[k,item[k]])),item_fingerprint:digest(item),artifacts};
 });
 const result={...Object.fromEntries(resultKeys.filter(k=>!['completed_at','items'].includes(k)).map(k=>[k,request[k]])),completed_at:new Date(now).toISOString(),items};
 inspectProductionResult(request,result,{root,now});return result;
}
