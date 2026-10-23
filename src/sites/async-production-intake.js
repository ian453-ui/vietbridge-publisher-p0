import {authorizationGuard,authorizationChanged,sha256} from './async-storage.js';

const fail=(code,status=409)=>{throw Object.assign(Error(code),{status});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const plain=(value,max)=>typeof value==='string'&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f]/u.test(value);
const plainBrief=(value)=>typeof value==='string'&&value.length<=4000&&value.trim()===value&&!/[\u0000-\u0009\u000b-\u001f]/u.test(value);
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail('INVALID_PRODUCTION_COMMAND',400);};

// Normalization is an identity hint only. This slice never fetches an untrusted URL.
export function normalizeLeadUrl(raw){
 if(!plain(raw,2048)||!raw)fail('INVALID_SOURCE_URL',400);
 let url;try{url=new URL(raw);}catch{fail('INVALID_SOURCE_URL',400);}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('INVALID_SOURCE_URL',400);
 const host=url.hostname.toLowerCase();
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.includes(':')||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))fail('UNSAFE_SOURCE_HOST',400);
 url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||['fbclid','gclid','msclkid'].includes(key.toLowerCase()))url.searchParams.delete(key);
 return url.href;
}

export const unconfiguredProductionProvider=Object.freeze({
 id:'UNCONFIGURED',configured:false,
 async research(){fail('MODEL_PROVIDER_UNCONFIGURED',503);},
 async draft(){fail('MODEL_PROVIDER_UNCONFIGURED',503);},
 async generateImage(){fail('IMAGE_PROVIDER_UNCONFIGURED',503);},
 async readReceipt(){fail('MODEL_PROVIDER_UNCONFIGURED',503);}
});

export class AsyncProductionIntake {
 constructor(db,{userId,workspace,now=()=>new Date().toISOString()}={}){
  if(!db?.prepare||!db?.batch)fail('SITES_RUNTIME_BINDING_REQUIRED',503);
  if(!userId||!uuid(workspace))fail('PRODUCTION_SCOPE_REQUIRED',400);
  this.db=db;this.userId=userId;this.workspace=workspace;this.now=now;
 }
 statement(query,args=[]){return this.db.prepare(query).bind(...args);}
 async rows(query,args=[]){const result=await this.statement(query,args).all();if(result.success===false||!Array.isArray(result.results))fail('STORAGE_UNAVAILABLE',503);return result.results;}
 async one(query,args=[]){return (await this.rows(query,args))[0]||null;}
 async scope(){if(!await this.one('SELECT 1 FROM sites_workspaces WHERE id=? AND owner_user_id=?',[this.workspace,this.userId]))fail('SCOPE_DENIED',403);}
 async batch(statements){
  const commands=[...statements,authorizationGuard(this.db,{userId:this.userId,workspace:this.workspace}),this.statement('DELETE FROM sites_authorization_assertions')];
  try{const results=await this.db.batch(commands);if(!Array.isArray(results)||results.length!==commands.length||results.some(result=>result.success===false))fail('STORAGE_OUTCOME_UNCONFIRMED',503);}
  catch(error){if(error.status)throw error;if(authorizationChanged(error))fail('SCOPE_DENIED',403);fail('STORAGE_WRITE_REJECTED',409);}
 }
 async job(id){await this.scope();if(!uuid(id))fail('INVALID_PRODUCTION_JOB',400);const row=await this.one('SELECT j.*,l.source_kind,l.original_url,l.canonical_url,l.title,l.brief,l.connector_id,l.event_id,l.source_hash,l.parent_lead_id,l.rights_status FROM sites_production_jobs j JOIN sites_production_leads l ON l.workspace=j.workspace AND l.id=j.lead_id WHERE j.workspace=? AND j.id=?',[this.workspace,id]);if(!row)fail('PRODUCTION_JOB_NOT_FOUND',404);return row;}
 async commandReceipt(id){
  await this.scope();if(!uuid(id))fail('INVALID_PRODUCTION_COMMAND',400);
  const row=await this.one("SELECT c.command_id,c.applied,c.lead_id,c.job_id,c.result_revision,c.result_state FROM sites_production_commands c JOIN sites_production_leads l ON l.id=c.lead_id JOIN sites_production_jobs j ON j.id=c.job_id AND j.lead_id=l.id JOIN sites_workspaces w ON w.id=l.workspace AND w.owner_user_id=c.owner_user_id WHERE c.owner_user_id=? AND c.command_id=? AND c.kind='CREATE' AND l.workspace=? AND j.workspace=?",[this.userId,id,this.workspace,this.workspace]);
  return row?.applied===1?{outcome:'COMMITTED',job_id:row.job_id,lead_id:row.lead_id,created_revision:row.result_revision,created_state:row.result_state,publish_allowed:false}:row?{outcome:'UNKNOWN',publish_allowed:false}:{outcome:'NO_RECEIPT',publish_allowed:false};
 }
 async list({cursor=''}={}){
  await this.scope();const [at,id]=cursor?cursor.split('|'):['',''];if(cursor&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)||!uuid(id)||cursor.split('|').length!==2))fail('PRODUCTION_CURSOR_INVALID',400);
  const rows=await this.rows("SELECT j.*,l.source_kind,l.canonical_url,l.title,l.brief,l.rights_status FROM sites_production_jobs j JOIN sites_production_leads l ON l.workspace=j.workspace AND l.id=j.lead_id WHERE j.workspace=? AND (?='' OR j.created_at<? OR (j.created_at=? AND j.id<?)) ORDER BY j.created_at DESC,j.id DESC LIMIT 51",[this.workspace,cursor,at,at,id]);
  const page=rows.slice(0,50),last=page.at(-1);return {jobs:page,next_cursor:rows.length>50?last.created_at+'|'+last.id:null,provider:{configured:false,id:'UNCONFIGURED'},publish_allowed:false};
 }
 async duplicates(leadId){const lead=await this.one('SELECT source_hash FROM sites_production_leads WHERE workspace=? AND id=?',[this.workspace,leadId]);return lead?this.rows('SELECT id,title,created_at FROM sites_production_leads WHERE workspace=? AND source_hash=? AND id<>? ORDER BY created_at DESC,id DESC LIMIT 10',[this.workspace,lead.source_hash,leadId]):[];}
 async create(input){
  exact(input,['command_id','source_kind','url','title','brief','connector_id','event_id','parent_lead_id']);
  if(!uuid(input.command_id)||!['URL','MANUAL'].includes(input.source_kind)||!plain(input.title,200)||!plainBrief(input.brief)||!plain(input.connector_id,100)||!input.connector_id||!plain(input.event_id,200)||!input.event_id||input.parent_lead_id!==null&&!uuid(input.parent_lead_id))fail('INVALID_PRODUCTION_COMMAND',400);
  if(input.source_kind==='MANUAL'&&(input.url!==null||!input.title))fail('INVALID_PRODUCTION_LEAD',400);
  if(input.source_kind==='URL'&&typeof input.url!=='string')fail('INVALID_PRODUCTION_LEAD',400);
  const canonical=input.source_kind==='URL'?normalizeLeadUrl(input.url):null;
  await this.scope();if(input.parent_lead_id&&!await this.one('SELECT 1 FROM sites_production_leads WHERE workspace=? AND id=?',[this.workspace,input.parent_lead_id]))fail('PARENT_LEAD_NOT_FOUND',404);
  const eventHash=await sha256(JSON.stringify({source_kind:input.source_kind,canonical_url:canonical,title:input.title,brief:input.brief,parent_lead_id:input.parent_lead_id}));
  const sourceHash=await sha256(JSON.stringify(canonical?{url:canonical}:{title:input.title.toLocaleLowerCase(),brief:input.brief.toLocaleLowerCase()}));
  const commandHash=await sha256(JSON.stringify({workspace:this.workspace,command_id:input.command_id,source_kind:input.source_kind,canonical_url:canonical,title:input.title,brief:input.brief,connector_id:input.connector_id,event_id:input.event_id,parent_lead_id:input.parent_lead_id}));
  const prior=await this.one('SELECT * FROM sites_production_commands WHERE owner_user_id=? AND command_id=?',[this.userId,input.command_id]);
  if(prior)return this.createReceipt(prior,commandHash,true);
  const duplicateEvent=await this.one('SELECT l.id,l.event_hash,j.id AS job_id FROM sites_production_leads l JOIN sites_production_jobs j ON j.workspace=l.workspace AND j.lead_id=l.id WHERE l.workspace=? AND l.connector_id=? AND l.event_id=?',[this.workspace,input.connector_id,input.event_id]);
  if(duplicateEvent){if(duplicateEvent.event_hash!==eventHash)fail('PRODUCTION_EVENT_CONFLICT');return this.recordDuplicateEvent(input,commandHash,eventHash);}
  const leadId=crypto.randomUUID(),jobId=crypto.randomUUID(),at=this.now(),winner=' FROM sites_production_commands c WHERE c.owner_user_id=? AND c.command_id=? AND c.command_hash=? AND c.lead_id=? AND c.applied=0',key=[this.userId,input.command_id,commandHash,leadId];
  try{await this.batch([
   this.statement("INSERT INTO sites_production_commands(owner_user_id,command_id,kind,command_hash,lead_id,job_id,applied,result_revision,result_state,created_at) VALUES(?,?,'CREATE',?,?,?,0,NULL,NULL,?) ON CONFLICT(owner_user_id,command_id) DO NOTHING",[this.userId,input.command_id,commandHash,leadId,jobId,at]),
   this.statement('INSERT INTO sites_production_leads(id,workspace,owner_user_id,source_kind,original_url,canonical_url,title,brief,connector_id,event_id,event_hash,source_hash,parent_lead_id,rights_status,created_at) SELECT c.lead_id,?,?,?,?,?,?,?,?,?,?,?,?,?,?'+winner,[this.workspace,this.userId,input.source_kind,input.url,canonical,input.title,input.brief,input.connector_id,input.event_id,eventHash,sourceHash,input.parent_lead_id,'UNVERIFIED',at,...key]),
   this.statement("INSERT INTO sites_production_jobs(id,workspace,lead_id,state,revision,provider_state,qa_state,created_at,updated_at) SELECT c.job_id,?,c.lead_id,'WAITING_PROVIDER',1,'UNCONFIGURED','BLOCKED',?,?"+winner,[this.workspace,at,at,...key]),
   this.statement("UPDATE sites_production_commands SET applied=1,result_revision=1,result_state='WAITING_PROVIDER' WHERE owner_user_id=? AND command_id=? AND command_hash=? AND lead_id=? AND applied=0",key)
  ]);}catch(error){
   if(error.message==='SCOPE_DENIED')throw error;
   const existing=await this.one('SELECT l.id,l.event_hash,j.id AS job_id FROM sites_production_leads l JOIN sites_production_jobs j ON j.workspace=l.workspace AND j.lead_id=l.id WHERE l.workspace=? AND l.connector_id=? AND l.event_id=?',[this.workspace,input.connector_id,input.event_id]);
   if(existing){if(existing.event_hash!==eventHash)fail('PRODUCTION_EVENT_CONFLICT');return this.recordDuplicateEvent(input,commandHash,eventHash);}
   throw error;
  }
  const receipt=await this.one('SELECT * FROM sites_production_commands WHERE owner_user_id=? AND command_id=?',[this.userId,input.command_id]);return this.createReceipt(receipt,commandHash,false);
 }
 async recordDuplicateEvent(input,hash,eventHash){
  await this.batch([this.statement("INSERT INTO sites_production_commands(owner_user_id,command_id,kind,command_hash,lead_id,job_id,applied,result_revision,result_state,created_at) SELECT ?,?,'CREATE',?,l.id,j.id,1,1,'WAITING_PROVIDER',? FROM sites_production_leads l JOIN sites_production_jobs j ON j.workspace=l.workspace AND j.lead_id=l.id WHERE l.workspace=? AND l.connector_id=? AND l.event_id=? AND l.event_hash=? ON CONFLICT(owner_user_id,command_id) DO NOTHING",[this.userId,input.command_id,hash,this.now(),this.workspace,input.connector_id,input.event_id,eventHash])]);
  const receipt=await this.one('SELECT * FROM sites_production_commands WHERE owner_user_id=? AND command_id=?',[this.userId,input.command_id]);return this.createReceipt(receipt,hash,true);
 }
 async createReceipt(receipt,hash,duplicate){if(!receipt||receipt.kind!=='CREATE'||receipt.command_hash!==hash)fail('COMMAND_CONFLICT');if(receipt.applied!==1)fail('COMMAND_OUTCOME_UNKNOWN');const job=await this.job(receipt.job_id);if(job.lead_id!==receipt.lead_id)fail('COMMAND_OUTCOME_UNKNOWN');return {job,duplicate,duplicate_candidates:await this.duplicates(receipt.lead_id),publish_allowed:false};}
 async action(id,input){
  exact(input,['command_id','action','expected_revision']);if(!uuid(id)||!uuid(input.command_id)||!['PAUSE','RESUME','CANCEL'].includes(input.action)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1)fail('INVALID_PRODUCTION_ACTION',400);
  const job=await this.job(id),hash=await sha256(JSON.stringify({workspace:this.workspace,job_id:id,...input}));
  const prior=await this.one('SELECT * FROM sites_production_commands WHERE owner_user_id=? AND command_id=?',[this.userId,input.command_id]);if(prior)return this.actionReceipt(prior,hash,true);
  const allowed=input.action==='RESUME'?['PAUSED']:input.action==='CANCEL'?['WAITING_PROVIDER','PAUSED']:['WAITING_PROVIDER'];
  if(job.revision!==input.expected_revision||!allowed.includes(job.state))fail('PRODUCTION_STATE_CONFLICT');
  const target=input.action==='PAUSE'?'PAUSED':input.action==='RESUME'?'WAITING_PROVIDER':'CANCELLED',at=this.now(),placeholders=allowed.map(()=>'?').join(',');
  await this.batch([
   this.statement(`INSERT INTO sites_production_commands(owner_user_id,command_id,kind,command_hash,lead_id,job_id,applied,result_revision,result_state,created_at) SELECT ?,?,'ACTION',?,j.lead_id,j.id,0,NULL,NULL,? FROM sites_production_jobs j WHERE j.workspace=? AND j.id=? AND j.revision=? AND j.state IN (${placeholders}) ON CONFLICT(owner_user_id,command_id) DO NOTHING`,[this.userId,input.command_id,hash,at,this.workspace,id,input.expected_revision,...allowed]),
   this.statement(`UPDATE sites_production_jobs SET state=?,revision=revision+1,updated_at=? WHERE workspace=? AND id=? AND revision=? AND state IN (${placeholders}) AND EXISTS(SELECT 1 FROM sites_production_commands c WHERE c.owner_user_id=? AND c.command_id=? AND c.command_hash=? AND c.job_id=? AND c.applied=0)`,[target,at,this.workspace,id,input.expected_revision,...allowed,this.userId,input.command_id,hash,id]),
   this.statement('UPDATE sites_production_commands SET applied=1,result_revision=?,result_state=? WHERE owner_user_id=? AND command_id=? AND command_hash=? AND job_id=? AND applied=0 AND EXISTS(SELECT 1 FROM sites_production_jobs j WHERE j.workspace=? AND j.id=? AND j.revision=? AND j.state=?)',[input.expected_revision+1,target,this.userId,input.command_id,hash,id,this.workspace,id,input.expected_revision+1,target])
  ]);
  const receipt=await this.one('SELECT * FROM sites_production_commands WHERE owner_user_id=? AND command_id=?',[this.userId,input.command_id]);if(!receipt)fail('PRODUCTION_STATE_CONFLICT');return this.actionReceipt(receipt,hash,false);
 }
 async actionReceipt(receipt,hash,duplicate){if(receipt.kind!=='ACTION'||receipt.command_hash!==hash)fail('COMMAND_CONFLICT');if(receipt.applied!==1)fail('COMMAND_OUTCOME_UNKNOWN');return {job:await this.job(receipt.job_id),receipt:{state:receipt.result_state,revision:receipt.result_revision},duplicate,publish_allowed:false};}
 async handoffCheck(id){const job=await this.job(id);return {job_id:id,eligible:false,blockers:job.state==='CANCELLED'?['PRODUCTION_CANCELLED']:['MODEL_PROVIDER_UNCONFIGURED','RESEARCH_EVIDENCE_MISSING','DRAFT_MISSING','IMAGE_MISSING','QA_MISSING'],target:'EXISTING_REVIEW_CHAIN',publish_allowed:false};}
}
