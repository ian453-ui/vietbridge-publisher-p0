import {AsyncStorage,bytes,digest,sha256,exact,text,fail} from './async-storage.js';

export const CLOUD_OBJECT_LIMIT=16*1024*1024;
export async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OBJECT_IO_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
/** DB-first intent + immutable scoped key + readback + conditional READY.
 * No deletes, listing sweep, TTL lease reclamation or cross-scope object access.
 */
export class ScopedObjectStore extends AsyncStorage {
 constructor(db,bucket,{timeoutMs=5000}={}){super(db);if(!bucket?.put||!bucket?.get)fail('R2_BINDING_REQUIRED');if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)fail('OBJECT_TIMEOUT_INVALID');this.bucket=bucket;this.timeoutMs=timeoutMs;}
 async row(id,scope){await this.scope(scope.workspace,scope.accountId);const row=await this.one('SELECT * FROM sites_objects WHERE id=? AND workspace=? AND account_id=?',[id,scope.workspace,scope.accountId]);if(!row)fail('OBJECT_NOT_FOUND');return row;}
 async readBody(row,deadline){
  const left=()=>{const remaining=Math.floor(deadline-performance.now());if(remaining<1)fail('OBJECT_IO_TIMEOUT');return remaining;};
  const object=await bounded(this.bucket.get(row.object_key),left());if(!object)fail('OBJECT_MISSING');
  if(object.size!==row.bytes||!object.body?.getReader)fail('OBJECT_INTEGRITY_MISMATCH');
  const reader=object.body.getReader(),chunks=[];let total=0,complete=false;
  try{while(true){const {done,value}=await bounded(reader.read(),left());if(done)break;total+=value.byteLength;if(total>row.bytes||total>CLOUD_OBJECT_LIMIT)fail('OBJECT_INTEGRITY_MISMATCH');chunks.push(value);}complete=true;}
  finally{if(!complete)reader.cancel().catch(()=>{});reader.releaseLock();}
  if(total!==row.bytes)fail('OBJECT_INTEGRITY_MISMATCH');const data=new Uint8Array(total);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.byteLength;}
  if(await sha256(data)!==row.sha256)fail('OBJECT_INTEGRITY_MISMATCH');return data;
 }
 async verify(id,scope,{deadline=performance.now()+this.timeoutMs}={}){
  const row=await this.row(id,scope);if(row.state==='CORRUPT')fail('OBJECT_CORRUPT');let data;
  try{data=await this.readBody(row,deadline);}catch(error){
   // Timeouts, transport failures and missing writes are not corruption evidence.
   if(error.message==='OBJECT_INTEGRITY_MISMATCH')await this.batch([this.statement("UPDATE sites_objects SET state='CORRUPT' WHERE id=? AND workspace=? AND account_id=?",[id,scope.workspace,scope.accountId])]);
   throw error;
  }
  await this.batch([this.scopeGuard(scope.workspace,scope.accountId),this.guard("EXISTS(SELECT 1 FROM sites_objects WHERE id=? AND state!='CORRUPT')",[id]),this.statement("UPDATE sites_objects SET state='READY' WHERE id=?",[id])]);
  return {id,sha256:row.sha256,mime:row.mime,data,state:'READY'};
 }
 async put(binding,data,mime,{deadline=performance.now()+this.timeoutMs}={}){
  exact(binding,['workspace','accountId','review_id','source_id','artifact_id']);if(Object.values(binding).some(v=>!text(v,300)))fail('OBJECT_BINDING_INVALID');const raw=bytes(data);
  if(raw.byteLength<1||raw.byteLength>CLOUD_OBJECT_LIMIT)fail('OBJECT_SIZE_LIMIT');if(!['video/mp4','video/webm','video/quicktime','image/png','image/jpeg','image/webp','text/plain; charset=utf-8'].includes(mime))fail('OBJECT_MIME_INVALID');
  await this.scope(binding.workspace,binding.accountId);const sha=await sha256(raw),id=await digest({binding,sha256:sha,bytes:raw.byteLength,mime}),key='publisher-v3/'+await digest({workspace:binding.workspace,account_id:binding.accountId})+'/'+id;
  await this.batch([this.scopeGuard(binding.workspace,binding.accountId),this.statement("INSERT INTO sites_objects VALUES(?,?,?,?,?,?,?,'STAGED',?) ON CONFLICT(id) DO NOTHING",[id,binding.workspace,binding.accountId,key,sha,raw.byteLength,mime,new Date().toISOString()])]);
  const row=await this.row(id,binding);if(row.state==='CORRUPT')fail('OBJECT_CORRUPT');
  try{return await this.verify(id,binding,{deadline});}catch(error){if(error.message!=='OBJECT_MISSING')throw error;}
  const remaining=Math.floor(deadline-performance.now());if(remaining<1)fail('OBJECT_IO_TIMEOUT');
  // Same deterministic key can only be written with the same verified bytes.
  // A put that committed then timed out leaves STAGED; recover reads it, never
  // assumes failure means absence. No compensating delete can race another user.
  await bounded(this.bucket.put(key,raw,{sha256:sha,httpMetadata:{contentType:mime},customMetadata:{object_id:id,sha256:sha}}),remaining);
  return this.verify(id,binding,{deadline});
 }
 async recoveryPlan(workspace,accountId){
  await this.scope(workspace,accountId);const rows=await this.rows("SELECT o.id,o.state,o.bytes,o.sha256,o.created_at,COUNT(a.object_id) references_count FROM sites_objects o LEFT JOIN sites_review_assets a ON a.object_id=o.id WHERE o.workspace=? AND o.account_id=? GROUP BY o.id ORDER BY o.created_at,o.id LIMIT 101",[workspace,accountId]);
  return {objects:rows.slice(0,100).map(r=>({...r,action:r.state==='CORRUPT'?'MANUAL_REPAIR_REQUIRED':r.references_count?'VERIFY_ON_READ':'RECONCILE_BY_ID',delete_allowed:false})),truncated:rows.length>100,delete_allowed:false};
 }
}
