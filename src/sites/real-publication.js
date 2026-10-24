import {AsyncStorage,sha256,exact,fail} from './async-storage.js';
import {ScopedObjectStore,CLOUD_OBJECT_LIMIT} from './scoped-object-store.js';

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const mimeTypes=new Set(['image/png','image/jpeg','image/webp','video/mp4']);
const signature=(mime,b)=>mime==='image/png'?b.length>=8&&[137,80,78,71,13,10,26,10].every((x,i)=>b[i]===x):mime==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:mime==='image/webp'?new TextDecoder().decode(b.slice(0,4))==='RIFF'&&new TextDecoder().decode(b.slice(8,12))==='WEBP':new TextDecoder().decode(b.slice(4,8))==='ftyp';
const digest=x=>sha256(JSON.stringify(x));
const checkNames=['text_checked','facts_checked','visual_checked','account_checked','platform_checked'];

/** Owner-visible real content workflow. This is separate from synthetic review
 * records. An owner assertion records manual QA; it never impersonates a model
 * inspection or a platform readback. Mac remains the execution authority.
 */
export class SiteRealPublication extends AsyncStorage {
 constructor(db,{bucket,relay=null,authorization,now=()=>new Date().toISOString()}={}){
  super(db,{authorization});this.bucket=bucket;this.relay=relay;this.now=now;
 }
 async content(id){
  const {workspace,accountId}=this.authorization;
  if(!uuid(id))fail('REAL_CONTENT_ID_INVALID');await this.scope(workspace,accountId);
  const row=await this.one('SELECT * FROM sites_contents WHERE id=? AND workspace=? AND account_id=?',[id,workspace,accountId]);
  if(!row)fail('REAL_CONTENT_NOT_FOUND');
  const latest=await this.one('SELECT max(revision) revision FROM sites_contents WHERE workspace=? AND account_id=? AND content_id=? AND slug=?',[workspace,accountId,row.content_id,row.slug]);
  if(latest.revision!==row.revision)fail('REAL_CONTENT_SUPERSEDED');return row;
 }
 async mediaRows(contentId){
  const {workspace,accountId}=this.authorization;
  return this.rows('SELECT ordinal,object_id,sha256,mime,bytes FROM sites_real_media WHERE content_id=? AND workspace=? AND account_id=? ORDER BY ordinal',[contentId,workspace,accountId]);
 }
 objects(){if(!this.bucket)fail('R2_BINDING_REQUIRED');return new ScopedObjectStore(this.db,this.bucket,{authorization:this.authorization});}
 async upload(contentId,ordinal,data,mime,expectedHash){
  const {workspace,accountId}=this.authorization;
  const c=await this.content(contentId),raw=data instanceof Uint8Array?data:new Uint8Array(data);
  if(!Number.isInteger(ordinal)||ordinal<0||ordinal>9||!mimeTypes.has(mime)||!hash(expectedHash)||raw.length<1||raw.length>CLOUD_OBJECT_LIMIT||!signature(mime,raw)||await sha256(raw)!==expectedHash)fail('REAL_MEDIA_INVALID');
  const existing=await this.one('SELECT * FROM sites_real_media WHERE content_id=? AND ordinal=?',[contentId,ordinal]);
  if(existing){if(existing.sha256!==expectedHash||existing.mime!==mime||existing.bytes!==raw.length)fail('REAL_MEDIA_CONFLICT');await this.objects().verify(existing.object_id,{workspace,accountId});return {ordinal,object_id:existing.object_id,sha256:existing.sha256,mime,bytes:existing.bytes,duplicate:true};}
  if(await this.one("SELECT 1 FROM sites_real_reviews WHERE content_id=? AND state='OWNER_REVIEWED'",[contentId]))fail('REAL_CONTENT_ALREADY_REVIEWED');
  const object=await this.objects().put({workspace,accountId,review_id:contentId,source_id:'OWNER_UPLOAD',artifact_id:String(ordinal)},raw,mime);
  await this.batch([
   this.guard("EXISTS(SELECT 1 FROM sites_contents WHERE id=? AND workspace=? AND account_id=? AND payload_hash=?) AND NOT EXISTS(SELECT 1 FROM sites_real_reviews WHERE content_id=? AND state='OWNER_REVIEWED')",[contentId,workspace,accountId,c.payload_hash,contentId]),
   this.statement('INSERT INTO sites_real_media VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(content_id,ordinal) DO NOTHING',[workspace,accountId,contentId,ordinal,object.id,expectedHash,mime,raw.length,this.now()]),
   this.guard('EXISTS(SELECT 1 FROM sites_real_media WHERE content_id=? AND ordinal=? AND object_id=? AND sha256=? AND mime=? AND bytes=?)',[contentId,ordinal,object.id,expectedHash,mime,raw.length])
  ]);
  return {ordinal,object_id:object.id,sha256:expectedHash,mime,bytes:raw.length,duplicate:false};
 }
 async preview(contentId){
  const c=await this.content(contentId),media=await this.mediaRows(contentId);
  if(media.some((m,i)=>m.ordinal!==i))fail('REAL_MEDIA_ORDER_INVALID');
  const mediaManifest=media.map(m=>({ordinal:m.ordinal,mime:m.mime,sha256:m.sha256,size:m.bytes}));
  const snapshot={content_id:c.id,workspace:c.workspace,account_id:c.account_id,source_content_id:c.content_id,slug:c.slug,revision:c.revision,title:c.title,body:c.body,variants:JSON.parse(c.variants_json),payload_hash:c.payload_hash,media:mediaManifest};
  const review=await this.one('SELECT state,snapshot_hash,receipt_hash,reviewed_at FROM sites_real_reviews WHERE content_id=?',[contentId]);
  return {...snapshot,snapshot_hash:await digest(snapshot),review:review||null};
 }
 async media(contentId,ordinal){
  await this.content(contentId);const row=(await this.mediaRows(contentId)).find(x=>x.ordinal===ordinal);
  if(!row)fail('REAL_MEDIA_NOT_FOUND');return this.objects().verify(row.object_id,{workspace:this.authorization.workspace,accountId:this.authorization.accountId});
 }
 async review(contentId,input){
  exact(input,['expected_snapshot_hash','source_refs','checks'],'REAL_REVIEW_INVALID');
  const p=await this.preview(contentId),{workspace,accountId,userId}=this.authorization;
  if(!hash(input.expected_snapshot_hash)||input.expected_snapshot_hash!==p.snapshot_hash||p.media.length<1||!Array.isArray(input.source_refs)||input.source_refs.length<1||input.source_refs.length>20||input.source_refs.some(x=>typeof x!=='string'||x.length<8||x.length>500||!x.startsWith('https://'))||!input.checks||Object.keys(input.checks).sort().join()!==[...checkNames].sort().join()||checkNames.some(k=>input.checks[k]!==true))fail('REAL_REVIEW_INCOMPLETE');
  for(const m of await this.mediaRows(contentId))await this.objects().verify(m.object_id,{workspace,accountId});
  const receipt={source:'OWNER_MANUAL_REVIEW',owner_user_id:userId,workspace,account_id:accountId,content_id:contentId,snapshot_hash:p.snapshot_hash,source_refs:input.source_refs,checks:input.checks,media:p.media};
  const receiptHash=await digest(receipt),old=await this.one('SELECT * FROM sites_real_reviews WHERE content_id=?',[contentId]);
  if(old){if(old.state!=='OWNER_REVIEWED'||old.receipt_hash!==receiptHash)fail('REAL_REVIEW_CONFLICT');return {state:old.state,receipt_hash:receiptHash,snapshot_hash:p.snapshot_hash,duplicate:true};}
  await this.batch([
   this.guard('EXISTS(SELECT 1 FROM sites_contents WHERE id=? AND workspace=? AND account_id=? AND payload_hash=?)',[contentId,workspace,accountId,p.payload_hash]),
   this.statement("INSERT INTO sites_real_reviews VALUES(?,?,?,?,?,?,?,?,'OWNER_REVIEWED',?,NULL) ON CONFLICT(content_id) DO NOTHING",[contentId,workspace,accountId,userId,p.snapshot_hash,receiptHash,JSON.stringify(input.source_refs),JSON.stringify(input.checks),this.now()]),
   this.guard("EXISTS(SELECT 1 FROM sites_real_reviews WHERE content_id=? AND workspace=? AND account_id=? AND owner_user_id=? AND snapshot_hash=? AND receipt_hash=? AND state='OWNER_REVIEWED')",[contentId,workspace,accountId,userId,p.snapshot_hash,receiptHash])
  ]);
  return {state:'OWNER_REVIEWED',receipt_hash:receiptHash,snapshot_hash:p.snapshot_hash,duplicate:false};
 }
 async freeze(contentId,input){
  exact(input,['site_job_id','expected_snapshot_hash','confirm'],'REAL_FREEZE_INVALID');
  const p=await this.preview(contentId),{workspace,accountId,userId}=this.authorization;
  if(!uuid(input.site_job_id)||input.confirm!==true||input.expected_snapshot_hash!==p.snapshot_hash||p.review?.state!=='OWNER_REVIEWED'||p.review.snapshot_hash!==p.snapshot_hash)fail('REAL_FREEZE_NOT_REVIEWED');
  const a=await this.scope(workspace,accountId);
  if(!a.external_identity||!p.variants[a.platform]||p.media.length<1)fail('REAL_ACCOUNT_OR_PLATFORM_UNVERIFIED');
  const payload=p.variants[a.platform],manifest={platform:a.platform,external_identity:a.external_identity,title:p.title,body:p.body,payload,media:p.media};
  const manifestHash=await digest(manifest),snapshot={site_job_id:input.site_job_id,site_workspace_id:workspace,site_account_id:accountId,content_id:contentId,source_snapshot_hash:p.snapshot_hash,qa_receipt_hash:p.review.receipt_hash,...manifest},siteHash=await digest(snapshot);
  const old=await this.one('SELECT * FROM sites_real_jobs WHERE job_id=? OR (workspace=? AND account_id=? AND content_id=?)',[input.site_job_id,workspace,accountId,contentId]);
  if(old){if(old.job_id!==input.site_job_id||old.site_snapshot_hash!==siteHash)fail('REAL_JOB_CONFLICT');return this.status(input.site_job_id);}
  await this.batch([
   this.guard("EXISTS(SELECT 1 FROM sites_real_reviews WHERE content_id=? AND workspace=? AND account_id=? AND snapshot_hash=? AND receipt_hash=? AND state='OWNER_REVIEWED')",[contentId,workspace,accountId,p.snapshot_hash,p.review.receipt_hash]),
   this.statement("INSERT INTO sites_real_jobs VALUES(?,?,?,?,?,?,?,?,?,'FROZEN',NULL,NULL,NULL,NULL,NULL,?,?) ON CONFLICT(job_id) DO NOTHING",[input.site_job_id,workspace,accountId,contentId,userId,siteHash,p.review.receipt_hash,manifestHash,JSON.stringify(snapshot),this.now(),this.now()]),
   this.guard('EXISTS(SELECT 1 FROM sites_real_jobs WHERE job_id=? AND workspace=? AND account_id=? AND site_snapshot_hash=?)',[input.site_job_id,workspace,accountId,siteHash])
  ]);
  return this.status(input.site_job_id);
 }
 async job(id){
  if(!uuid(id))fail('REAL_JOB_ID_INVALID');const {workspace,accountId}=this.authorization;
  await this.scope(workspace,accountId);const row=await this.one('SELECT * FROM sites_real_jobs WHERE job_id=? AND workspace=? AND account_id=?',[id,workspace,accountId]);
  if(!row)fail('REAL_JOB_NOT_FOUND');return row;
 }
 async list(){
  const {workspace,accountId}=this.authorization;await this.scope(workspace,accountId);
  return this.rows('SELECT job_id,state,site_snapshot_hash,qa_receipt_hash,manifest_hash,local_job_id,updated_at FROM sites_real_jobs WHERE workspace=? AND account_id=? ORDER BY created_at DESC,job_id DESC LIMIT 100',[workspace,accountId]);
 }
 async status(id){
  const row=await this.job(id),readback=row.readback_json?JSON.parse(row.readback_json):null;
  return {site_job_id:id,state:row.state,site_snapshot_hash:row.site_snapshot_hash,qa_receipt_hash:row.qa_receipt_hash,manifest_hash:row.manifest_hash,prepare_command_id:row.prepare_command_id,submit_command_id:row.submit_command_id,local_job_id:row.local_job_id,local_snapshot_hash:row.local_snapshot_hash,readback,verified:readback?.verified===true&&readback?.evidence_origin==='MAC_UNIFIED_EXECUTOR_READBACK',relay_available:!!this.relay};
 }
 async requireFrozen(row){
  const review=await this.one('SELECT state,receipt_hash,snapshot_hash FROM sites_real_reviews WHERE content_id=?',[row.content_id]);
  const p=await this.preview(row.content_id),a=await this.scope(row.workspace,row.account_id),snap=JSON.parse(row.snapshot_json);
  if(review?.state!=='OWNER_REVIEWED'||review.receipt_hash!==row.qa_receipt_hash||review.snapshot_hash!==p.snapshot_hash||snap.source_snapshot_hash!==p.snapshot_hash||snap.external_identity!==a.external_identity||snap.platform!==a.platform||await digest({platform:snap.platform,external_identity:snap.external_identity,title:snap.title,body:snap.body,payload:snap.payload,media:snap.media})!==row.manifest_hash)fail('REAL_JOB_CHANGED');
  return snap;
 }
 async prepare(id,commandId){
  const row=await this.job(id);if(!uuid(commandId)||!['FROZEN','PREPARE_INTENT'].includes(row.state)||row.prepare_command_id&&row.prepare_command_id!==commandId||!this.relay)fail('REAL_PREPARE_UNAVAILABLE');
  const snap=await this.requireFrozen(row);
  if(row.state==='PREPARE_INTENT'){
   try{const prior=await this.relay.status(id);if(prior.site_workspace_id!==row.workspace||prior.site_account_id!==row.account_id||prior.site_snapshot_hash!==row.site_snapshot_hash)fail('REAL_RELAY_SCOPE_MISMATCH');
    const next=prior.state==='READY'?'PREPARED':prior.verified===true&&prior.evidence_origin==='MAC_UNIFIED_EXECUTOR_READBACK'&&['PUBLISHED','PUBLISHED_ID_PENDING'].includes(prior.state)?prior.state:'UNKNOWN';
    await this.batch([this.guard("EXISTS(SELECT 1 FROM sites_real_jobs WHERE job_id=? AND state='PREPARE_INTENT' AND prepare_command_id=?)",[id,commandId]),this.statement("UPDATE sites_real_jobs SET state=?,local_job_id=?,local_snapshot_hash=?,readback_json=?,updated_at=? WHERE job_id=? AND state='PREPARE_INTENT'",[next,prior.local_job_id,prior.local_snapshot_hash,JSON.stringify(prior),this.now(),id])]);return this.status(id);
   }catch(error){if(error.message!=='V3_BINDING_NOT_FOUND')throw error;}
  }else await this.batch([this.guard("EXISTS(SELECT 1 FROM sites_real_jobs WHERE job_id=? AND state='FROZEN' AND site_snapshot_hash=?)",[id,row.site_snapshot_hash]),this.statement("UPDATE sites_real_jobs SET state='PREPARE_INTENT',prepare_command_id=?,updated_at=? WHERE job_id=? AND state='FROZEN'",[commandId,this.now(),id])]);
  const media=await this.mediaRows(row.content_id);
  for(const m of media){const obj=await this.objects().verify(m.object_id,{workspace:row.workspace,accountId:row.account_id});await this.relay.upload(id,m.ordinal,{mime:m.mime,sha256:m.sha256,size:m.bytes,body:obj.data});}
  const prepared=await this.relay.prepare(id,{site_job_id:id,site_workspace_id:row.workspace,site_account_id:row.account_id,site_snapshot_hash:row.site_snapshot_hash,platform:snap.platform,external_identity:snap.external_identity,qa_receipt_hash:row.qa_receipt_hash,title:snap.title,body:snap.body,payload:snap.payload,media:snap.media});
  if(prepared.site_workspace_id!==row.workspace||prepared.site_account_id!==row.account_id)fail('REAL_RELAY_SCOPE_MISMATCH');
  await this.batch([this.guard("EXISTS(SELECT 1 FROM sites_real_jobs WHERE job_id=? AND state='PREPARE_INTENT' AND prepare_command_id=?)",[id,commandId]),this.statement("UPDATE sites_real_jobs SET state='PREPARED',local_job_id=?,local_snapshot_hash=?,readback_json=?,updated_at=? WHERE job_id=? AND state='PREPARE_INTENT'",[prepared.local_job_id,prepared.local_snapshot_hash,JSON.stringify(prepared),this.now(),id])]);
  return this.status(id);
 }
 async refresh(id){
  const row=await this.job(id);if(!this.relay||!['PREPARE_INTENT','PREPARED','SUBMIT_INTENT','UNKNOWN','PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_WRITTEN','BLOCKED'].includes(row.state))return this.status(id);
  let remote;try{remote=await this.relay.status(id);}catch(error){if(error.message==='V3_BINDING_NOT_FOUND'&&row.state==='PREPARE_INTENT')return this.status(id);throw error;}
  if(remote.site_workspace_id!==row.workspace||remote.site_account_id!==row.account_id||remote.site_snapshot_hash!==row.site_snapshot_hash||row.local_snapshot_hash&&remote.local_snapshot_hash!==row.local_snapshot_hash)fail('REAL_RELAY_SCOPE_MISMATCH');
  const next=remote.state==='PUBLISHED'||remote.state==='PUBLISHED_ID_PENDING'?(remote.verified===true&&remote.evidence_origin==='MAC_UNIFIED_EXECUTOR_READBACK'?remote.state:'UNKNOWN'):remote.state==='DRAFT_WRITTEN'?'DRAFT_WRITTEN':remote.state==='UNKNOWN'?'UNKNOWN':row.state;
  // The relay call can outlive a concurrent submit. A stale READY readback must
  // never move SUBMIT_INTENT (or its later outcome) back to PREPARED.
  await this.batch([this.statement('UPDATE sites_real_jobs SET state=?,local_job_id=?,local_snapshot_hash=?,readback_json=?,updated_at=? WHERE job_id=? AND workspace=? AND account_id=? AND site_snapshot_hash=? AND state=?',[next,remote.local_job_id,remote.local_snapshot_hash,JSON.stringify(remote),this.now(),id,row.workspace,row.account_id,row.site_snapshot_hash,row.state])]);
  return this.status(id);
 }
 async dispatch(id,input){
  exact(input,['confirm','site_snapshot_hash','local_snapshot_hash','command_id'],'REAL_SUBMIT_INVALID');const row=await this.job(id);
  if(!this.relay||row.state!=='PREPARED'||!uuid(input.command_id)||input.confirm!==true||input.site_snapshot_hash!==row.site_snapshot_hash||input.local_snapshot_hash!==row.local_snapshot_hash)fail('REAL_SUBMIT_UNAVAILABLE');
  await this.requireFrozen(row);const capability=await this.relay.capability(id);
  if(capability.site_snapshot_hash!==row.site_snapshot_hash||capability.local_snapshot_hash!==row.local_snapshot_hash||capability.capability?.canExecute!==true)fail('REAL_LOCAL_EXECUTION_UNAVAILABLE');
  await this.batch([this.guard("EXISTS(SELECT 1 FROM sites_real_jobs WHERE job_id=? AND state='PREPARED' AND local_snapshot_hash=?)",[id,row.local_snapshot_hash]),this.statement("UPDATE sites_real_jobs SET state='SUBMIT_INTENT',submit_command_id=?,updated_at=? WHERE job_id=? AND state='PREPARED'",[input.command_id,this.now(),id])]);
  await this.relay.dispatch(id,{confirm:true,site_snapshot_hash:row.site_snapshot_hash,local_snapshot_hash:row.local_snapshot_hash});
  return this.refresh(id);
 }
}
