import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readSync,constants,realpathSync} from 'node:fs';
import {ProductionApprovalStore} from './production-approval-store.js';
import {isSyntheticPublicationFactory} from './synthetic-publication-driver.js';

export const handoffHash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error(code);};
const exists=db=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_upload_bindings'").get());
export function productionBinding(db,contentId){
 if(!exists(db))return null;
 const row=db.prepare('SELECT p.* FROM production_upload_plans p JOIN production_upload_bindings b ON b.plan_id=p.id WHERE b.content_id=?').get(contentId);if(!row)return null;
 if(handoffHash(row.manifest_json)!==row.manifest_hash)fail('PRODUCTION_PLAN_CORRUPT');return {...row,manifest:JSON.parse(row.manifest_json)};
}
export function productionPlanMarker(plan){return {plan_id:plan.id,subject_fingerprint:plan.subject_fingerprint,approval_event_id:plan.approval_event_id,synthetic_only:true};}
export function readHandoffBytes(asset){
 const fd=openSync(asset.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==asset.bytes||stat.size>128*1024*1024)fail('PRODUCTION_MEDIA_CHANGED');const data=Buffer.alloc(stat.size);let offset=0;while(offset<data.length){const n=readSync(fd,data,offset,data.length-offset,null);if(!n)fail('PRODUCTION_MEDIA_CHANGED');offset+=n;}if(readSync(fd,Buffer.alloc(1),0,1,null)||handoffHash(data)!==asset.sha256)fail('PRODUCTION_MEDIA_CHANGED');return data;}finally{closeSync(fd);}
}
export function assertProductionPlanCurrent(db,plan){
 const approval=new ProductionApprovalStore(db).view(plan.review_id,{workspace:plan.workspace,accountId:plan.account_id});
 if(approval.state!=='CONTENT_APPROVED'||approval.provenance!=='SYNTHETIC_FIXTURE'||approval.subject_fingerprint!==plan.subject_fingerprint||approval.latest_event_id!==plan.approval_event_id)fail('PRODUCTION_APPROVAL_CHANGED');
 for(const asset of plan.manifest.media)readHandoffBytes(asset);
 return plan;
}
export function assertProductionDraft(db,contentId,{workspace,accountId,platform,payload,media}){
 const plan=productionBinding(db,contentId);if(!plan)return null;
 if(plan.workspace!==workspace||plan.account_id!==accountId||plan.manifest.platform!==platform)fail('PRODUCTION_PLAN_SCOPE_DENIED');
 assertProductionPlanCurrent(db,plan);
 const expected=plan.manifest.payload;
 if(['title','body','author'].some(k=>String(payload[k]||'')!==String(expected[k]||''))||handoffHash(payload.tags||[])!==handoffHash(expected.tags||[])||handoffHash(media)!==handoffHash(plan.manifest.media.map(x=>x.path)))fail('PRODUCTION_APPROVED_PAYLOAD_CHANGED');
 return productionPlanMarker(plan);
}
export function assertProductionJobCurrent(db,job){
 const plan=productionBinding(db,job.content_id);if(!plan){if(job.snapshot.productionReview)fail('PRODUCTION_PLAN_MISSING');return null;}
 const marker=assertProductionDraft(db,job.content_id,{workspace:job.workspace,accountId:job.account_id,platform:job.snapshot.platform,payload:job.snapshot.payload,media:job.snapshot.media});
 if(handoffHash(marker)!==handoffHash(job.snapshot.productionReview||{}))fail('PRODUCTION_PLAN_BINDING_CHANGED');return plan;
}
export function assertProductionExecution(db,job,factory,{reconcile=false}={}){
 const plan=productionBinding(db,job.content_id);if(!plan&&!job.snapshot.productionReview)return;
 if(!plan||handoffHash(productionPlanMarker(plan))!==handoffHash(job.snapshot.productionReview||{}))fail('PRODUCTION_PLAN_BINDING_CHANGED');
 if(plan.workspace!==job.workspace||plan.account_id!==job.account_id||plan.manifest.platform!==job.snapshot.platform||handoffHash(job.snapshot)!==job.snapshot_hash)fail('PRODUCTION_PLAN_SCOPE_DENIED');
 if(!isSyntheticPublicationFactory(factory))fail('PRODUCTION_PREVIEW_ONLY_NO_PUBLISH_AUTHORITY');
 // Reconcile the original frozen simulated submission even if its approval was later revoked.
 if(!reconcile)assertProductionJobCurrent(db,job);
}
export function assertNoProductionMediaClone(db,media=[]){
 if(!exists(db))return;
 const planned=db.prepare("SELECT 1 FROM production_upload_plans p,json_each(p.manifest_json,'$.media') a WHERE json_extract(a.value,'$.path')=? LIMIT 1");
 const frozen=db.prepare("SELECT 1 FROM sqlite_master WHERE name='publisher_job_assets'").get()?db.prepare('SELECT 1 FROM publisher_job_assets a JOIN publisher_jobs j ON j.id=a.job_id JOIN production_upload_bindings b ON b.content_id=j.content_id WHERE a.path=? LIMIT 1'):null;
 for(const path of media){let actual;try{actual=realpathSync(path);}catch{continue;}if(planned.get(actual)||frozen?.get(actual))fail('PRODUCTION_MEDIA_REQUIRES_BOUND_PLAN');}
}
