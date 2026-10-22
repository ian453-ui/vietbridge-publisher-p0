import {mkdtempSync,openSync,readSync,fstatSync,closeSync,writeFileSync,rmSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {validateArchiveReference} from './archive-asset-resolver.js';
import {verifyProductionRequest,packageProductionResult,PRODUCTION_BATCH_LIMITS} from './production-artifact-contract.js';

const fail=code=>{throw Error(code);};
const exact=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail('ARCHIVE_MANIFEST_INVALID');};

/** ZIP -> bounded hot materialization -> existing production contract -> existing Review ledger. */
export async function ingestArchiveProduction(request,manifest,{resolver,reviewStore,now=Date.now()}={}){
 verifyProductionRequest(request);exact(manifest,['schema_version','request_fingerprint','completed_at','items']);
 if(manifest.schema_version!==1||manifest.request_fingerprint!==request.request_fingerprint||!Array.isArray(manifest.items)||manifest.items.length!==request.items.length)fail('ARCHIVE_MANIFEST_INVALID');
 const completedAt=Date.parse(manifest.completed_at);if(!Number.isFinite(completedAt)||new Date(completedAt).toISOString()!==manifest.completed_at||completedAt<Date.parse(request.created_at)||completedAt>now)fail('ARCHIVE_MANIFEST_TIME_INVALID');
 const selected=[],sources=new Set();let bytes=0,videos=0,transferBytes=0;
 for(const row of manifest.items){
  exact(row,['source_id','files']);const item=request.items.find(x=>x.source_id===row.source_id);
  if(!item||sources.has(row.source_id)||!Array.isArray(row.files)||row.files.length!==item.deliverables.length)fail('ARCHIVE_MANIFEST_INVALID');sources.add(row.source_id);
  const seen=new Set();for(const file of row.files){
   exact(file,['artifact_id','archive']);const spec=item.deliverables.find(x=>x.artifact_id===file.artifact_id);
   if(!spec||seen.has(file.artifact_id))fail('ARCHIVE_MANIFEST_INVALID');seen.add(file.artifact_id);
   const binding={project_id:request.workspace,account_id:request.account_id,content_id:row.source_id},reference=validateArchiveReference(file.archive,binding);
   if(reference.kind!==spec.kind)fail('ARCHIVE_MANIFEST_KIND_MISMATCH');
   bytes+=reference.member_size;transferBytes+=reference.archive_size;videos+=spec.kind==='video'?1:0;selected.push({source_id:row.source_id,artifact_id:file.artifact_id,binding,reference});
  }
 }
 if(selected.length>PRODUCTION_BATCH_LIMITS.artifacts||videos>PRODUCTION_BATCH_LIMITS.videos||bytes>PRODUCTION_BATCH_LIMITS.bytes||transferBytes>256*1024*1024)fail('ARCHIVE_BATCH_BUDGET_EXCEEDED');
 // All manifest budgets and identity bindings above precede transport or external tools.
 reviewStore.scope(request.workspace,request.account_id);
 const root=mkdtempSync(join(tmpdir(),'publisher-archive-intake-')),leases=[],deadlineAt=performance.now()+30000;
 try{
  const selections=manifest.items.map(item=>({source_id:item.source_id,files:[]}));
  for(const [index,item] of selected.entries()){
   const media=await resolver.resolve(item.reference,{binding:item.binding,deadlineAt});leases.push({id:media.lease_id,binding:item.binding});
   const fd=openSync(join(media.root,media.path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   let data;try{
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==item.reference.member_size)fail('ARCHIVE_CACHE_CORRUPT');
    data=Buffer.alloc(stat.size);let offset=0;while(offset<data.length){const n=readSync(fd,data,offset,data.length-offset,null);if(!n)fail('ARCHIVE_CACHE_CORRUPT');offset+=n;}
    if(readSync(fd,Buffer.alloc(1),0,1,null)||createHash('sha256').update(data).digest('hex')!==item.reference.sha256)fail('ARCHIVE_CACHE_CORRUPT');
   }finally{closeSync(fd);}
   const path=index+extname(item.reference.member_path).toLowerCase();writeFileSync(join(root,path),data,{flag:'wx',mode:0o600});
   selections.find(x=>x.source_id===item.source_id).files.push({artifact_id:item.artifact_id,path});
  }
  if(performance.now()>deadlineAt)fail('ARCHIVE_BATCH_TIME_LIMIT');
  const remaining=()=>{const left=Math.floor(deadlineAt-performance.now());if(left<1)fail('ARCHIVE_BATCH_TIME_LIMIT');return Math.min(left,30000);};
  const result=packageProductionResult(request,selections,{root,now:completedAt,wallMs:remaining()});
  const receipt=reviewStore.ingest(request,result,{root,now,wallMs:remaining()});
  return {...receipt,archive_members:selected.length,originals_deleted:false,upload_input:'EXTRACTED_LOCAL_MEDIA',producer_authenticated:false};
 }finally{
  try{for(const lease of leases)resolver.release(lease.id,{binding:lease.binding});}
  finally{rmSync(root,{recursive:true,force:true});}
 }
}
