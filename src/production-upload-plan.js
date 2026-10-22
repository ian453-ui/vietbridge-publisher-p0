import {mkdirSync,mkdtempSync,lstatSync,writeFileSync,renameSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {ProductionReviewStore} from './production-review-store.js';
import {sourcePlatformPayload} from './platform-copy-provenance.js';
import {validatePlatformPayload} from './publisher-platforms.js';
import {handoffHash,productionBinding,assertProductionPlanCurrent,readHandoffBytes} from './production-handoff-guard.js';

const fail=code=>{throw Error(code);};
const flags={publish_allowed:false,source_gate_satisfied:false,producer_authenticated:false,synthetic_only:true};
const extension=mime=>({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4'}[mime]||fail('PRODUCTION_UPLOAD_MEDIA_UNSUPPORTED'));

/** Joins existing review bytes to native content variants, DRAFT jobs and freezeMedia. */
export class ProductionUploadPlans {
 constructor(publisher,executor,{root}){
  this.publisher=publisher;this.executor=executor;this.db=publisher.db;this.reviews=new ProductionReviewStore(this.db);this.root=root;
  this.db.exec(`CREATE TABLE IF NOT EXISTS production_upload_plans(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,account_id TEXT NOT NULL,review_id TEXT NOT NULL,subject_fingerprint TEXT NOT NULL,approval_event_id TEXT NOT NULL,manifest_json TEXT NOT NULL,manifest_hash TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS production_upload_bindings(content_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE REFERENCES production_upload_plans(id));
   CREATE TABLE IF NOT EXISTS production_upload_jobs(plan_id TEXT PRIMARY KEY REFERENCES production_upload_plans(id),job_id TEXT NOT NULL UNIQUE REFERENCES publisher_jobs(id));`);
 }
 choices(reviewId,scope){
  const row=this.reviews.approvals.row(reviewId,scope),request=JSON.parse(row.request_json),platform=this.publisher.account(scope.workspace,scope.accountId).platform;
  return request.items.flatMap(item=>item.deliverables.filter(a=>a.kind==='platform_payload'&&a.platform===platform).map(a=>({source_id:item.source_id,payload_artifact_id:a.artifact_id,platform})));
 }
 view(planId,scope){
  const link=this.db.prepare('SELECT b.content_id,j.job_id FROM production_upload_bindings b JOIN production_upload_jobs j ON j.plan_id=b.plan_id WHERE b.plan_id=?').get(planId);if(!link)fail('PRODUCTION_PLAN_NOT_FOUND');
  const plan=productionBinding(this.db,link.content_id);if(plan.workspace!==scope.workspace||plan.account_id!==scope.accountId)fail('PRODUCTION_PLAN_SCOPE_DENIED');assertProductionPlanCurrent(this.db,plan);
  const assets=this.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=? ORDER BY ordinal').all(link.job_id);if(assets.length!==plan.manifest.media.length)fail('PRODUCTION_FROZEN_MEDIA_MISSING');for(const [i,asset] of assets.entries()){if(asset.sha256!==plan.manifest.media[i].sha256)fail('PRODUCTION_MEDIA_CHANGED');readHandoffBytes({...asset,bytes:asset.size});}
  return {id:plan.id,review_id:plan.review_id,source_id:plan.manifest.source_id,platform:plan.manifest.platform,...link,job_state:this.publisher.job(plan.workspace,link.job_id).state,status:'UPLOAD_PREVIEW_ONLY',payload_source_sha256:plan.manifest.payload_source_sha256,payload:plan.manifest.payload,media:plan.manifest.media.map(({path,...a})=>a),...flags};
 }
 prepare(reviewId,input,scope,{authority}={}){
  if(authority?.kind!=='EXISTING_ADMIN'||!/^admin:[a-f0-9]{64}$/.test(authority.actor_id||''))fail('APPROVAL_ADMIN_REQUIRED');
  if(!input||Object.keys(input).sort().join(',')!=='expected_event_id,expected_subject,payload_artifact_id,source_id'||Object.values(input).some(x=>typeof x!=='string'||!x))fail('PRODUCTION_PLAN_INPUT_INVALID');
  const approval=this.reviews.approvals.view(reviewId,scope,{admin:true});
  if(approval.state!=='CONTENT_APPROVED'||approval.provenance!=='SYNTHETIC_FIXTURE'||!approval.can_decide)fail('PRODUCTION_APPROVED_SYNTHETIC_SOURCE_REQUIRED');
  if(input.expected_subject!==approval.subject_fingerprint||input.expected_event_id!==approval.latest_event_id)fail('PRODUCTION_APPROVAL_CHANGED');
  const id=handoffHash({review_id:reviewId,workspace:scope.workspace,account_id:scope.accountId,source_id:input.source_id,payload_artifact_id:input.payload_artifact_id,subject:input.expected_subject,event:input.expected_event_id}),prior=this.db.prepare('SELECT id FROM production_upload_plans WHERE id=?').get(id);if(prior)return {...this.view(id,scope),duplicate:true};
  const row=this.reviews.approvals.row(reviewId,scope),request=JSON.parse(row.request_json),item=request.items.find(x=>x.source_id===input.source_id),spec=item?.deliverables.find(a=>a.artifact_id===input.payload_artifact_id),account=this.publisher.account(scope.workspace,scope.accountId);
  if(!spec||spec.kind!=='platform_payload'||spec.platform!==account.platform)fail('PRODUCTION_PLATFORM_PAYLOAD_REQUIRED');
  const selected=spec.references.map(key=>item.deliverables.find(a=>a.artifact_id===key)).filter(a=>a&&['cover','video'].includes(a.kind));if(!selected.length)fail('PRODUCTION_EXPLICIT_MEDIA_REFERENCE_REQUIRED');
  const raw=this.reviews.asset(scope.workspace,scope.accountId,reviewId,item.source_id,spec.artifact_id),payload={...sourcePlatformPayload(Buffer.from(raw.data).toString('utf8'),item.source_id,account.platform)};payload.title=payload.title.trim();payload.body=payload.body.trim();payload.author=payload.author||'驻越经营实录';
  const assets=selected.map(a=>({...this.reviews.asset(scope.workspace,scope.accountId,reviewId,item.source_id,a.artifact_id),artifact_id:a.artifact_id,source_id:item.source_id}));
  if(assets.length>100||assets.reduce((sum,a)=>sum+a.data.length,0)>128*1024*1024)fail('PRODUCTION_UPLOAD_BUDGET');
  if(assets.some(a=>a.mime==='video/mp4')&&assets.length!==1)fail('PRODUCTION_UPLOAD_MIXED_MEDIA');
  // A private local staging directory, no arbitrary caller path or archive URL.
  mkdirSync(this.root,{recursive:true,mode:0o700});if(lstatSync(this.root).isSymbolicLink()||!lstatSync(this.root).isDirectory())fail('PRODUCTION_UPLOAD_ROOT_INVALID');this.root=realpathSync(this.root);
  const destination=join(this.root,id);let staging,renamed=false,newJobDirectory;
  try{return this.publisher.store.tx(()=>{
   // SQLite serializes duplicate preparation across processes before filesystem mutation.
   if(this.db.prepare('SELECT id FROM production_upload_plans WHERE id=?').get(id))return {...this.view(id,scope),duplicate:true};
   if(existsSync(destination))fail('PRODUCTION_UPLOAD_ORPHAN_RECONCILE_PENDING');staging=mkdtempSync(join(this.root,'.stage-'));
   const media=assets.map((asset,index)=>{const name=index+extension(asset.mime);writeFileSync(join(staging,name),asset.data,{flag:'wx',mode:0o600});return {source_id:asset.source_id,artifact_id:asset.artifact_id,mime:asset.mime,bytes:asset.data.length,sha256:asset.sha256,path:join(destination,name)};});
   validatePlatformPayload(account.platform,payload,media.map(a=>a.path));
   const manifest={source_id:item.source_id,payload_artifact_id:spec.artifact_id,payload_source_sha256:raw.sha256,platform:account.platform,payload,media},manifestJson=JSON.stringify(manifest);
   this.db.prepare('INSERT INTO production_upload_plans VALUES(?,?,?,?,?,?,?,?,?)').run(id,scope.workspace,scope.accountId,reviewId,approval.subject_fingerprint,approval.latest_event_id,manifestJson,handoffHash(manifestJson),new Date().toISOString());
   renameSync(staging,destination);renamed=true;
   const content=this.publisher.importContent(scope.workspace,{source_id:'production-review:'+id,revision:'1',title:payload.title,body:payload.body,media:media.map(a=>a.path),platform_payloads:{[account.platform]:{...payload,media:media.map(a=>a.path)}}},{productionPlanId:id});
   this.db.prepare('INSERT INTO production_upload_bindings VALUES(?,?)').run(content.id,id);
   const job=this.publisher.createPageJob(scope.workspace,{account_id:scope.accountId,content_id:content.id});
   const jobDirectory=join(this.executor.snapshotRoot,job.id);if(!existsSync(jobDirectory))newJobDirectory=jobDirectory;
   this.executor.freezeMedia(job);this.db.prepare('INSERT INTO production_upload_jobs VALUES(?,?)').run(id,job.id);
   this.publisher.store.event(scope.workspace,'production_upload_preview_prepared',{plan_id:id,job_id:job.id,review_id:reviewId,actor_id:authority.actor_id,...flags});
   return {...this.view(id,scope),duplicate:false};
  });}catch(error){for(const directory of [renamed?destination:null,newJobDirectory].filter(Boolean))try{rmSync(directory,{recursive:true,force:true});}catch{error.cleanup_pending=true;}throw error;}finally{if(staging)try{rmSync(staging,{recursive:true,force:true});}catch{/* orphan staging has no committed plan and is never a valid upload input */}}
 }
 previewMetadata(contentId){const plan=productionBinding(this.db,contentId);return plan?{plan_id:plan.id,review_id:plan.review_id,workspace:plan.workspace,account_id:plan.account_id,platform:plan.manifest.platform,media:plan.manifest.media.map(({source_id,artifact_id})=>({source_id,artifact_id})),...flags}:null;}
}
