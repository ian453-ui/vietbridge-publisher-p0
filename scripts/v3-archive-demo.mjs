import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {v3ReviewDemo} from './v3-review-demo.mjs';
import {ArchiveAssetResolver} from '../src/archive-asset-resolver.js';
import {ingestArchiveProduction} from '../src/archive-production-intake.js';
import {createProductionRequest} from '../src/production-artifact-contract.js';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {makeZip,sha256} from '../test/fixtures/synthetic-archive.js';

/** Synthetic local archive transport only; no real Drive adapter or deletion. */
export async function v3ArchiveDemo(out){
 const demo=v3ReviewDemo(out),cold=join(out,'synthetic-cold-archive');mkdirSync(cold);
 const original=JSON.parse(readFileSync(join(out,'request.json'))),{request_fingerprint,assignment_mode,handoff_policy,...plan}=original;plan.task_id='SYNTHETIC-ARCHIVE-PRODUCTION';
 const request=createProductionRequest(plan),selections=JSON.parse(readFileSync(join(out,'production/selections.json')));
 const entries=selections.flatMap(row=>row.files.map(file=>({name:file.path,data:readFileSync(join(demo.artifactRoot,file.path))}))),zip=makeZip(entries),parts=[];
 for(let index=0;index<3;index++){
  const bytes=zip.subarray(Math.floor(zip.length*index/3),Math.floor(zip.length*(index+1)/3)),file_id='synthetic-cold-part-'+index;
  writeFileSync(join(cold,file_id),bytes,{flag:'wx'});parts.push({index,file_id,bytes:bytes.length,sha256:sha256(bytes)});
 }
 const manifest={schema_version:1,request_fingerprint:request.request_fingerprint,completed_at:new Date().toISOString(),items:selections.map(row=>({source_id:row.source_id,files:row.files.map(file=>{
  const data=entries.find(e=>e.name===file.path).data,spec=request.items.find(x=>x.source_id===row.source_id).deliverables.find(x=>x.artifact_id===file.artifact_id);
  return {artifact_id:file.artifact_id,archive:{schema_version:1,type:'ZIP_BYTE_PARTS',project_id:request.workspace,account_id:request.account_id,content_id:row.source_id,archive_file_id:'synthetic-cold-archive',archive_size:zip.length,archive_sha256:sha256(zip),member_path:file.path,member_size:data.length,sha256:sha256(data),kind:spec.kind,parts}};
 })}))};
 for(const [name,value] of Object.entries({'archive-request':request,'archive-manifest':manifest}))writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2),{flag:'wx'});
 const resolver=new ArchiveAssetResolver({root:join(out,'archive-hot-cache'),fetchPart:async({fileId})=>{
  if(!parts.some(p=>p.file_id===fileId))throw Error('ARCHIVE_PART_MISSING');return readFileSync(join(cold,fileId));
 }}),db=new DatabaseSync(demo.dbPath);
 try{
  const receipt=await ingestArchiveProduction(request,manifest,{resolver,reviewStore:new ProductionReviewStore(db)});
  const summary={...demo,archive_receipt:receipt,cold_directory:cold,archive_manifest:join(out,'archive-manifest.json'),synthetic_only:true};
  writeFileSync(join(out,'archive-demo.json'),JSON.stringify(summary,null,2),{flag:'wx'});return summary;
 }finally{resolver.close();db.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3)throw Error('USAGE: node scripts/v3-archive-demo.mjs NEW_DIRECTORY');console.log(JSON.stringify(await v3ArchiveDemo(resolve(process.argv[2]))));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
