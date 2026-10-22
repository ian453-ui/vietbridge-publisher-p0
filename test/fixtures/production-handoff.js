import {readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {v3ArchiveDemo} from '../../scripts/v3-archive-demo.mjs';
import {Store} from '../../src/store.js';
import {UnifiedPublisher} from '../../src/unified-publisher.js';
import {UnifiedExecutor} from '../../src/unified-executor.js';
import {BrowserResources} from '../../src/browser-resources.js';
import {ProductionReviewStore} from '../../src/production-review-store.js';
import {ProductionUploadPlans} from '../../src/production-upload-plan.js';
import {createProductionRequest} from '../../src/production-artifact-contract.js';
import {ArchiveAssetResolver} from '../../src/archive-asset-resolver.js';
import {ingestArchiveProduction} from '../../src/archive-production-intake.js';
import {syntheticPublicationFactory} from '../../src/synthetic-publication-driver.js';
import {seedSyntheticApproval,syntheticAdmin,approvalCommand} from './synthetic-approval.js';
import {makeZip,sha256} from './synthetic-archive.js';

export async function handoffFixture(root,{video=false,platform='facebook'}={}){
 const demo=await v3ArchiveDemo(join(root,'demo')),store=new Store(demo.dbPath,{seedDemo:false}),publisher=new UnifiedPublisher(store),reviews=new ProductionReviewStore(store.db),scope={workspace:demo.workspace,accountId:platform==='xiaohongshu'?demo.secondAccountId:demo.accountId};
 let reviewId=demo.archive_receipt.id,sourceId='SYNTHETIC-KB-003';
 if(video||platform==='xiaohongshu'){
  const original=JSON.parse(readFileSync(join(root,'demo/archive-request.json'))),{request_fingerprint,assignment_mode,handoff_policy,...plan}=original;plan.task_id='SYNTHETIC-HANDOFF-'+platform.toUpperCase();plan.account_id=scope.accountId;plan.items=plan.items.filter(x=>x.source_id===(video?'SYNTHETIC-VIDEO-001':'SYNTHETIC-KB-003'));sourceId=plan.items[0].source_id;
  plan.items[0].deliverables=plan.items[0].deliverables.filter(a=>a.kind!=='platform_payload');plan.items[0].deliverables.push({artifact_id:platform,kind:'platform_payload',language:'vi+zh',platform,references:[video?'video':'cover']});
  const request=createProductionRequest(plan),entries=(video?['script.md','subtitle.srt','video.mp4','cover.png']:['article.md','cover.png']).map(name=>({name:sourceId+'/'+name,data:readFileSync(join(demo.artifactRoot,sourceId,name))}));entries.push({name:sourceId+'/platform.txt',data:Buffer.from(platform==='xiaohongshu'?'title: Synthetic XHS\nbody: Synthetic distinct Xiaohongshu copy.\ntags:\n  - Fixture':'Synthetic video platform copy from the approved archive.')});
  const zip=makeZip(entries),part={index:0,file_id:'synthetic-video-zip',bytes:zip.length,sha256:sha256(zip)},names={article:'article.md',script:'script.md',subtitle:'subtitle.srt',video:'video.mp4',cover:'cover.png',[platform]:'platform.txt'};
  const manifest={schema_version:1,request_fingerprint:request.request_fingerprint,completed_at:new Date().toISOString(),items:[{source_id:sourceId,files:plan.items[0].deliverables.map(spec=>{const entry=entries.find(e=>e.name===sourceId+'/'+names[spec.artifact_id]);return {artifact_id:spec.artifact_id,archive:{schema_version:1,type:'ZIP_BYTE_PARTS',project_id:scope.workspace,account_id:scope.accountId,content_id:sourceId,archive_file_id:'synthetic-video-zip',archive_size:zip.length,archive_sha256:sha256(zip),member_path:entry.name,member_size:entry.data.length,sha256:sha256(entry.data),kind:spec.kind,parts:[part]}};})}]};
  const resolver=new ArchiveAssetResolver({root:join(root,'video-cache'),fetchPart:async()=>zip});try{reviewId=(await ingestArchiveProduction(request,manifest,{resolver,reviewStore:reviews})).id;}finally{resolver.close();}
 }
 const approval=seedSyntheticApproval(reviews,reviewId,scope);reviews.approvals.decide(reviewId,approvalCommand(approval),scope,{authority:syntheticAdmin});
 const current=reviews.approvals.view(reviewId,scope),input={source_id:sourceId,payload_artifact_id:platform,expected_subject:current.subject_fingerprint,expected_event_id:current.latest_event_id},factory=syntheticPublicationFactory(store.db),options={enabled:true,resources:new BrowserResources(join(root,'locks')),drivers:factory,mediaRoots:[],snapshotRoot:join(root,'job-assets')},executor=new UnifiedExecutor(publisher,options),plans=new ProductionUploadPlans(publisher,executor,{root:join(root,'upload-media')});
 const profile=publisher.context(scope.workspace,scope.accountId).profile;if(profile)mkdirSync(profile.user_data_dir,{recursive:true});
 return {root,demo,store,publisher,reviews,scope,reviewId,sourceId,input,factory,executor,plans,options,prepare:()=>plans.prepare(reviewId,input,scope,{authority:syntheticAdmin})};
}
