import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,openSync,readSync,fstatSync,closeSync,constants} from 'node:fs';
import {join,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyProductionRequest,packageProductionInspection} from './production-artifact-contract.js';
import {bounded} from './sites/scoped-object-store.js';
import {validateArchiveReference} from './archive-asset-resolver.js';
const fail=code=>{throw Error(code);};
const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>hash(JSON.stringify(canonical(x)));
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>0;
const path=x=>typeof x==='string'&&x.length<=300&&!/[\\:\0]/.test(x)&&x.split('/').every(p=>p&&p!=='.'&&p!=='..');
const mime=ext=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4'}[ext]||'text/plain; charset=utf-8');

/** Cloud heavy-service adapter over existing canonical manifest fields. No Drive
 * client, credential, scope registration or production dispatcher is created.
 * Server-injected reads must return exact metadata + bytes, not authenticated=true.
 */
export class CanonicalSourceInspector {
 constructor({binding,readManifest,readFile,getRequest,resolver=null,now=()=>Date.now()}={}){
  if(!binding||!['workspace','accountId','project_id','source_folder_id','manifest_file_id','content_id'].every(k=>id(binding[k]))||typeof binding.slug!=='string'||!binding.slug.trim()||binding.slug.length>300||/[\x00-\x1f]/.test(binding.slug)||typeof readManifest!=='function'||typeof readFile!=='function'||typeof getRequest!=='function')fail('SOURCE_PROVIDER_UNAVAILABLE');
  this.binding=Object.freeze({...binding});this.readManifest=readManifest;this.readFile=readFile;this.getRequest=getRequest;this.resolver=resolver;this.now=now;this.issued=new WeakMap();this.lastCleanup=[];
 }
 async describe(reference){
  const b=this.binding;if(reference.workspace!==b.workspace||reference.accountId!==b.accountId||!id(reference.task_id)||!integer(reference.request_revision))fail('SOURCE_SCOPE_DENIED');
  const response=await this.readBounded(this.readManifest,{fileId:b.manifest_file_id,binding:{...b},maxBytes:256*1024});
  if(response?.file_id!==b.manifest_file_id||!integer(response.revision)||response.project_id!==b.project_id||response.source_folder_id!==b.source_folder_id||!Buffer.isBuffer(response.data)||!response.data.length||response.data.length>256*1024)fail('SOURCE_MANIFEST_BINDING');
  let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.data));}catch{fail('SOURCE_MANIFEST_INVALID');}
  if(manifest.project_id!==b.project_id)fail('SOURCE_PROJECT_MISMATCH');
  const candidates=Array.isArray(manifest.items)?manifest.items:[manifest];if(candidates.length>1000)fail('SOURCE_MANIFEST_LIMIT');
  const matches=candidates.filter(x=>x&&(x.content_id??x.article_id)===b.content_id&&x.slug===b.slug),item=matches.length===1?matches[0]:{};
  let identity_error=matches.length!==1?'SOURCE_CONTENT_AMBIGUOUS':(item.content_id&&item.article_id&&item.content_id!==item.article_id||item.source_folder_id!==b.source_folder_id)?'SOURCE_IDENTITY_MISMATCH':null;
  const request=await this.readBounded(this.getRequest,{...reference});verifyProductionRequest(request);
  if(request.workspace!==b.workspace||request.account_id!==b.accountId||request.task_id!==reference.task_id||request.request_revision!==reference.request_revision)fail('SOURCE_REQUEST_SCOPE');
  let plan,preflight_error=identity_error;try{if(!preflight_error)plan=this.plan(item,request,reference,response);}catch(error){preflight_error=/^(SOURCE|ARCHIVE)_[A-Z_]+$/.test(error.message)?error.message:'SOURCE_MANIFEST_INVALID';}
  const summary={...b,source_revision:response.revision,manifest_sha256:hash(response.data),content_revision:item.content_revision??null,visual_revision:item.visual_revision??null,qa_status:typeof item.qa_status==='string'?item.qa_status:'UNKNOWN',canonical_metadata:item};
  const description={summary,descriptor_hash:digest(summary),request,files:plan?.files||[],preflight_error};this.issued.set(description,digest(description));return description;
 }
 async readBounded(read,args,ms=5000){const controller=new AbortController();try{return await bounded(Promise.resolve().then(()=>read({...args,signal:controller.signal})),ms);}finally{controller.abort();}}
 plan(item,request,reference,response){const b=this.binding;
  const parts=String(item.source_doc_id||'').split('#'),[doc,anchor]=parts;if(parts.length>2)fail('SOURCE_DOCUMENT_BINDING');if(!id(doc)||anchor&&anchor!==b.content_id||item.source_doc_anchor&&item.source_doc_anchor!==b.content_id)fail('SOURCE_DOCUMENT_BINDING');
  if(!integer(item.content_revision)||!integer(item.visual_revision))fail('SOURCE_VERSION_REQUIRED');
  const files=[{artifact_id:'body',kind:'knowledge_article',filename:item.body_source,drive_file_id:item.content_drive_file_id,revision:item.body_source_revision,sha256:item.body_source_sha256,bytes:item.body_source_bytes,archive:item.body_archive??null,source_doc_id:doc}];
  const names=Array.isArray(item.active_assets)?item.active_assets:[item.primary_image];if(!names.length||names.length>30||new Set(names).size!==names.length)fail('SOURCE_ASSET_BINDING');
  for(const [index,name] of names.entries()){
   const metadata=item.asset_sources?.[name]??(name===item.primary_image?{drive_file_id:item.primary_image_drive_file_id,revision:item.primary_image_revision,sha256:item.primary_image_sha256,bytes:item.primary_image_bytes,archive:item.primary_image_archive,source_doc_id:item.primary_image_source_doc_id}:null);
   if(!metadata||metadata.source_doc_id!==doc||metadata.content_id&&metadata.content_id!==b.content_id||metadata.project_id&&metadata.project_id!==b.project_id)fail('SOURCE_IMAGE_DOCUMENT_MISMATCH');
   files.push({artifact_id:metadata.artifact_id||(index===0?'cover':'asset-'+(index+1)),kind:metadata.kind||'cover',filename:name,drive_file_id:metadata.drive_file_id??metadata.file_id,revision:metadata.revision,sha256:metadata.sha256,bytes:metadata.bytes,archive:metadata.archive??null,source_doc_id:doc});
  }
  let size=0,transfer=0;for(const f of files){
   const extension=extname(f.filename||'').toLowerCase();if(!id(f.artifact_id)||!path(f.filename)||!sha(f.sha256)||!integer(f.bytes)||f.bytes>16*1024*1024||!['knowledge_article','cover','video'].includes(f.kind)||!(f.kind==='knowledge_article'?['.md']:f.kind==='cover'?['.png','.jpg','.jpeg','.webp']:['.mp4']).includes(extension))fail('SOURCE_FILE_CONTRACT_INVALID');size+=f.bytes;
   if(f.archive){f.archive=validateArchiveReference(f.archive,{project_id:b.workspace,account_id:b.accountId,content_id:b.content_id});if(f.archive.sha256!==f.sha256||f.archive.member_size!==f.bytes||f.archive.kind!==f.kind||extname(f.archive.member_path).toLowerCase()!==extension)fail('SOURCE_ARCHIVE_BINDING');transfer+=f.archive.archive_size;}
   else if(!id(f.drive_file_id)||!integer(f.revision))fail('SOURCE_FILE_VERSION_REQUIRED');
  }
  if(files.length>32||size>32*1024*1024||transfer>256*1024*1024||new Set(files.map(f=>f.artifact_id)).size!==files.length)fail('SOURCE_BATCH_LIMIT');
  const ri=request.items[0],manifestHash=hash(response.data);
  if(request.items.length!==1||request.workspace!==b.workspace||request.account_id!==b.accountId||request.task_id!==reference.task_id||request.request_revision!==reference.request_revision||ri.source_id!==b.content_id||ri.content_revision!==item.content_revision||ri.visual_revision!==item.visual_revision||ri.deliverables.length!==files.length||!ri.source_refs.some(r=>r.source_id===b.manifest_file_id&&r.revision===String(response.revision)&&r.sha256===manifestHash))fail('SOURCE_REQUEST_BINDING');
  for(const f of files)if(!ri.deliverables.some(d=>d.artifact_id===f.artifact_id&&d.kind===f.kind))fail('SOURCE_REQUEST_ARTIFACT_BINDING');
  return {files};
 }

 async inspect(description){
  if(!this.issued.has(description))fail('SOURCE_DESCRIPTION_NOT_ISSUED');if(this.issued.get(description)!==digest(description))fail('SOURCE_DESCRIPTION_CHANGED');if(description.preflight_error)fail(description.preflight_error);
  const {request,files}=description,b=this.binding,root=mkdtempSync(join(tmpdir(),'canonical-review-')),leases=[],selections=[{source_id:b.content_id,files:[]}],deadline=performance.now()+30000;let packet,error;this.lastCleanup=[];
  try{
   for(const [index,f] of files.entries()){
    if(performance.now()>=deadline)fail('SOURCE_READ_TIMEOUT');let data;
    if(f.archive){
     if(!this.resolver)fail('SOURCE_ARCHIVE_RESOLVER_UNAVAILABLE');const binding={project_id:b.workspace,account_id:b.accountId,content_id:b.content_id},resolved=await this.resolver.resolve(f.archive,{binding,deadlineAt:deadline});leases.push({id:resolved.lease_id,binding});
     const fd=openSync(join(resolved.root,resolved.path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==f.bytes)fail('SOURCE_FILE_BYTES_MISMATCH');data=Buffer.alloc(f.bytes);let at=0;while(at<data.length){const n=readSync(fd,data,at,data.length-at,null);if(!n)fail('SOURCE_FILE_BYTES_MISMATCH');at+=n;}if(readSync(fd,Buffer.alloc(1),0,1,null))fail('SOURCE_FILE_BYTES_MISMATCH');}finally{closeSync(fd);}
    }else{
     const r=await this.readBounded(this.readFile,{fileId:f.drive_file_id,revision:f.revision,binding:{...b,source_doc_id:f.source_doc_id},maxBytes:f.bytes},Math.max(1,Math.min(5000,deadline-performance.now())));
     if(r?.file_id!==f.drive_file_id||r.revision!==f.revision||r.project_id!==b.project_id||r.workspace!==b.workspace||r.accountId!==b.accountId||r.source_folder_id!==b.source_folder_id||r.source_doc_id!==f.source_doc_id||r.content_id!==b.content_id)fail('SOURCE_FILE_IDENTITY_MISMATCH');data=r.data;
    }
    if(!Buffer.isBuffer(data)||data.length!==f.bytes||hash(data)!==f.sha256)fail('SOURCE_FILE_BYTES_MISMATCH');
    const filename=index+extname(f.filename).toLowerCase();writeFileSync(join(root,filename),data,{flag:'wx',mode:0o600});selections[0].files.push({artifact_id:f.artifact_id,path:filename});
   }
   const remaining=()=>{const n=Math.floor(deadline-performance.now());if(n<1)fail('SOURCE_READ_TIMEOUT');return Math.min(n,30000);},now=this.now(),{result,report,snapshots}=packageProductionInspection(request,selections,{root,now,wallMs:remaining()});packet={request,result,report,assets:snapshots.map(s=>({source_id:s.source_id,artifact_id:s.artifact_id,mime:mime(s.extension),data:s.data}))};
  }catch(e){error=e;}finally{
   for(const lease of leases)try{this.resolver.release(lease.id,{binding:lease.binding});}catch{this.lastCleanup.push({operation:'LEASE_RELEASE',reason:'RECONCILE_PENDING'});}
   try{rmSync(root,{recursive:true,force:true});}catch{this.lastCleanup.push({operation:'STAGING_CLEANUP',reason:'RECONCILE_PENDING'});}
  }if(error)throw error;return packet;
 }
}
