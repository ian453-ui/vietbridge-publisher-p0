import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {packageProductionInspection} from '../../src/production-artifact-contract.js';
// Test-only native decoding adapter, never wired to the hosted application.
export function syntheticVariantInspector(root){let calls=0;return {get calls(){return calls;},async inspectVariant({request,assets}){
 calls++;const dir=join(root,'variant-inspection-'+crypto.randomUUID());mkdirSync(dir);
 const descriptors=assets.map((a,i)=>{const ext=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4'}[a.mime]||'.md'),path=String(i)+ext;writeFileSync(join(dir,path),a.data);return {...a,path};});
 const selections=request.items.map(item=>({source_id:item.source_id,files:item.deliverables.map(spec=>({artifact_id:spec.artifact_id,path:descriptors.find(a=>a.source_id===item.source_id&&a.artifact_id===spec.artifact_id).path}))}));
 const {result,report,snapshots}=packageProductionInspection(request,selections,{root:dir});
 return {request,result,report,assets:snapshots.map(a=>({source_id:a.source_id,artifact_id:a.artifact_id,mime:assets.find(x=>x.source_id===a.source_id&&x.artifact_id===a.artifact_id).mime,data:a.data}))};
 }};}
