import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,readdirSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join,extname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProductionArtifact} from './production-artifact-contract.js';

const fail=code=>{throw Error(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(x);
const exact=(value,keys)=>{if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail('ARCHIVE_REFERENCE_INVALID');};
const kinds=new Set(['knowledge_article','script','subtitle','video','cover','platform_payload']);
const scopeKeys=['project_id','account_id','content_id'];
const memberPath=p=>typeof p==='string'&&p.length>0&&p.length<=500&&p.normalize('NFC')===p&&!/[\\:\0]/.test(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
function scope(reference,binding){
 exact(binding,scopeKeys);for(const k of scopeKeys)if(!id(binding[k])||reference[k]!==binding[k])fail('ARCHIVE_SCOPE_DENIED');
}
export function validateArchiveReference(reference,binding){
 exact(reference,['schema_version','type',...scopeKeys,'archive_file_id','archive_size','archive_sha256','member_path','member_size','sha256','kind','parts']);scope(reference,binding);
 if(reference.schema_version!==1||reference.type!=='ZIP_BYTE_PARTS'||!id(reference.archive_file_id)||!memberPath(reference.member_path)||!hex(reference.sha256)||!hex(reference.archive_sha256)||!kinds.has(reference.kind)||!Number.isSafeInteger(reference.archive_size)||reference.archive_size<1||reference.archive_size>128*1024*1024)fail('ARCHIVE_REFERENCE_INVALID');
 const memberMax=reference.kind==='video'?100*1024*1024:reference.kind==='cover'?20000000:1024*1024;
 if(!Number.isSafeInteger(reference.member_size)||reference.member_size<1||reference.member_size>memberMax)fail('ARCHIVE_REFERENCE_INVALID');
 if(!Array.isArray(reference.parts)||!reference.parts.length||reference.parts.length>32)fail('ARCHIVE_PARTS_INVALID');
 const seen=new Set();let total=0;
 reference.parts.forEach((part,index)=>{
  exact(part,['index','file_id','bytes','sha256']);if(part.index!==index||!id(part.file_id)||seen.has(part.file_id)||!hex(part.sha256)||!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>reference.archive_size)fail('ARCHIVE_PARTS_INVALID');
  seen.add(part.file_id);total+=part.bytes;
 });
 if(total!==reference.archive_size||reference.parts.length===1&&(reference.parts[0].file_id!==reference.archive_file_id||reference.parts[0].sha256!==reference.archive_sha256))fail('ARCHIVE_PARTS_INVALID');
 // Canonical ordering makes caller property insertion order irrelevant to cache identity.
 return {schema_version:1,type:'ZIP_BYTE_PARTS',...Object.fromEntries(scopeKeys.map(k=>[k,reference[k]])),archive_file_id:reference.archive_file_id,archive_size:reference.archive_size,archive_sha256:reference.archive_sha256,member_path:reference.member_path,member_size:reference.member_size,sha256:reference.sha256,kind:reference.kind,parts:reference.parts.map(p=>({index:p.index,file_id:p.file_id,bytes:p.bytes,sha256:p.sha256}))};
}

/** Isolated local cache; injected transport must supply already authorized bytes. */
export class ArchiveAssetResolver {
 constructor({root,fetchPart,ttlMs=3600000,transferTimeoutMs=30000,now=()=>Date.now()}={}){
  if(!isAbsolute(root||'')||typeof fetchPart!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>7*86400000||!Number.isSafeInteger(transferTimeoutMs)||transferTimeoutMs<25||transferTimeoutMs>30000)fail('ARCHIVE_RESOLVER_CONFIG_INVALID');
  if(!existsSync(root))mkdirSync(root,{recursive:true,mode:0o700});
  if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory())fail('ARCHIVE_CACHE_ROOT_INVALID');
  this.root=realpathSync(root);const marker=join(this.root,'.publisher-archive-cache');
  if(!existsSync(marker)){if(readdirSync(this.root).length)fail('ARCHIVE_CACHE_NOT_EMPTY');writeFileSync(marker,'publisher-archive-cache-v1\n',{flag:'wx',mode:0o600});}
  if(lstatSync(marker).isSymbolicLink()||readFileSync(marker,'utf8')!=='publisher-archive-cache-v1\n')fail('ARCHIVE_CACHE_ROOT_INVALID');
  for(const name of ['entries','staging']){const path=join(this.root,name);if(!existsSync(path))mkdirSync(path,{mode:0o700});if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())fail('ARCHIVE_CACHE_ROOT_INVALID');}
  const dbFile=join(this.root,'archive-cache.sqlite');if(existsSync(dbFile)&&lstatSync(dbFile).isSymbolicLink())fail('ARCHIVE_CACHE_ROOT_INVALID');
  this.db=new DatabaseSync(dbFile);this.fetchPart=fetchPart;this.now=now;this.ttlMs=ttlMs;this.transferTimeoutMs=transferTimeoutMs;
  this.db.exec(`PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS archive_cache(key TEXT PRIMARY KEY NOT NULL,state TEXT NOT NULL CHECK(state IN ('BUILDING','READY','CORRUPT')),reference_json TEXT NOT NULL,stage TEXT NOT NULL,owner_pid INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS archive_leases(id TEXT PRIMARY KEY NOT NULL,cache_key TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS archive_attempts(id TEXT PRIMARY KEY NOT NULL,cache_key TEXT NOT NULL,project_id TEXT NOT NULL,account_id TEXT NOT NULL,content_id TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS archive_reference_history(asset_key TEXT NOT NULL,revision INTEGER NOT NULL,reference_json TEXT NOT NULL,operation TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(asset_key,revision));`);
 }
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 paths(key,stage,extension){if(!hex(key)||!/^[a-f0-9-]{36}$/.test(stage))fail('ARCHIVE_CACHE_RECORD_INVALID');return {entry:join(this.root,'entries',key),staging:join(this.root,'staging',stage),file:join(this.root,'entries',key,'media'+extension)};}
 entryArtifact(key,reference,{wallMs}={}){
  if(!hex(key))fail('ARCHIVE_CACHE_RECORD_INVALID');const directory=join(this.root,'entries',key);
  if(realpathSync(directory)!==directory||lstatSync(directory).isSymbolicLink())fail('ARCHIVE_CACHE_CORRUPT');
  const actual=readProductionArtifact(directory,'media'+extname(reference.member_path).toLowerCase(),reference.kind,{wallMs});
  if(actual.sha256!==reference.sha256)fail('ARCHIVE_CACHE_CORRUPT');return actual;
 }
 async download(reference,timeoutMs=this.transferTimeoutMs){
  const controller=new AbortController(),deadline=performance.now()+Math.min(timeoutMs,this.transferTimeoutMs);let timer;
  try{return await Promise.race([
   (async()=>{const parts=[];for(const part of reference.parts){
    const result=await this.fetchPart({fileId:part.file_id,binding:Object.fromEntries(scopeKeys.map(k=>[k,reference[k]])),signal:controller.signal,maxBytes:part.bytes});
    if(controller.signal.aborted)fail('ARCHIVE_TRANSFER_TIMEOUT');
    const stream=Buffer.isBuffer(result)?[result]:result;if(!stream?.[Symbol.asyncIterator]&&!stream?.[Symbol.iterator])fail('ARCHIVE_TRANSFER_INVALID');
    const chunks=[];let length=0;for await(const chunk of stream){if(controller.signal.aborted||performance.now()>deadline)fail('ARCHIVE_TRANSFER_TIMEOUT');if(!Buffer.isBuffer(chunk)||!chunk.length||chunks.length>=8192)fail('ARCHIVE_TRANSFER_INVALID');length+=chunk.length;if(length>part.bytes)fail('ARCHIVE_PART_SIZE_MISMATCH');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);if(length!==part.bytes||hash(bytes)!==part.sha256)fail('ARCHIVE_PART_HASH_MISMATCH');parts.push(bytes);
   }const bytes=Buffer.concat(parts);if(bytes.length!==reference.archive_size||hash(bytes)!==reference.archive_sha256)fail('ARCHIVE_HASH_MISMATCH');return bytes;})(),
   new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('ARCHIVE_TRANSFER_TIMEOUT'));},Math.min(timeoutMs,this.transferTimeoutMs));})
  ]);}finally{clearTimeout(timer);controller.abort();}
 }
 async resolve(input,{binding,deadlineAt=performance.now()+30000}={}){
  const remaining=max=>{const left=Math.floor(deadlineAt-performance.now());if(!Number.isFinite(left)||left<1)fail('ARCHIVE_BATCH_TIME_LIMIT');return Math.min(left,max);};remaining(30000);
  const reference=validateArchiveReference(input,binding),key=hash(JSON.stringify(reference)),stage=randomUUID(),leaseId=randomUUID(),extension=extname(reference.member_path).toLowerCase();
  const paths=this.paths(key,stage,extension);let build=false,verified;
  this.tx(()=>{
   const row=this.db.prepare('SELECT * FROM archive_cache WHERE key=?').get(key);
   if(row&&row.state!=='READY')fail(row.state==='BUILDING'?'ARCHIVE_CACHE_BUSY':'ARCHIVE_CACHE_CORRUPT');
   if(!row){const occupied=this.db.prepare('SELECT reference_json,state FROM archive_cache').all();if(occupied.length>=128||occupied.filter(x=>x.state==='BUILDING').reduce((sum,x)=>sum+JSON.parse(x.reference_json).archive_size,0)+reference.archive_size>256*1024*1024||occupied.reduce((sum,x)=>sum+JSON.parse(x.reference_json).member_size,0)+reference.member_size>256*1024*1024)fail('ARCHIVE_CACHE_CAPACITY');build=true;this.db.prepare('INSERT INTO archive_cache VALUES(?,?,?,?,?,?)').run(key,'BUILDING',JSON.stringify(reference),stage,process.pid,this.now()+this.ttlMs);this.db.prepare('INSERT INTO archive_attempts VALUES(?,?,?,?,?,?,?,?)').run(stage,key,reference.project_id,reference.account_id,reference.content_id,'FETCHING',null,this.now());}
   else{this.db.prepare('INSERT INTO archive_leases VALUES(?,?,?)').run(leaseId,key,this.now());this.db.prepare('UPDATE archive_cache SET expires_at=? WHERE key=?').run(this.now()+this.ttlMs,key);}
  });
  if(build){
   try{
    mkdirSync(paths.staging,{mode:0o700});const zip=join(paths.staging,'source.zip'),file=join(paths.staging,'media'+extension);
    writeFileSync(zip,await this.download(reference,remaining(30000)),{flag:'wx',mode:0o600});
    this.db.prepare("UPDATE archive_attempts SET state='VALIDATING' WHERE id=?").run(stage);
    const result=spawnSync('python3',['-I','-B',fileURLToPath(new URL('./archive-extract.py',import.meta.url))],{input:JSON.stringify({archive:zip,output:file,member:reference.member_path,member_size:reference.member_size,sha256:reference.sha256}),encoding:'utf8',timeout:remaining(8000),killSignal:'SIGKILL',maxBuffer:8192});
    if(result.error||result.signal)fail('ARCHIVE_EXTRACT_UNAVAILABLE_OR_LIMIT');
    if(result.status!==0)fail(/^ARCHIVE_[A-Z_]+$/.test(result.stderr.trim())?result.stderr.trim():'ARCHIVE_ZIP_INVALID');
    const actual=readProductionArtifact(paths.staging,'media'+extension,reference.kind,{wallMs:remaining(30000)});if(actual.sha256!==reference.sha256)fail('ARCHIVE_MEMBER_HASH_MISMATCH');verified=actual;
    rmSync(zip);
    this.tx(()=>{if(realpathSync(join(this.root,'entries'))!==join(this.root,'entries'))fail('ARCHIVE_CACHE_ROOT_INVALID');renameSync(paths.staging,paths.entry);this.db.prepare("UPDATE archive_cache SET state='READY',expires_at=? WHERE key=? AND state='BUILDING'").run(this.now()+this.ttlMs,key);this.db.prepare('INSERT INTO archive_leases VALUES(?,?,?)').run(leaseId,key,this.now());this.db.prepare("UPDATE archive_attempts SET state='MATERIALIZED' WHERE id=?").run(stage);});
   }catch(error){
    this.tx(()=>{this.db.prepare("DELETE FROM archive_cache WHERE key=? AND state='BUILDING' AND stage=?").run(key,stage);this.db.prepare("UPDATE archive_attempts SET state='FAILED',reason=? WHERE id=?").run(/^(ARCHIVE|VIDEO|IMAGE)_[A-Z_]+$/.test(error.message)?error.message:'ARCHIVE_INTAKE_FAILED',stage);rmSync(paths.staging,{recursive:true,force:true});rmSync(paths.entry,{recursive:true,force:true});});throw error;
   }
  }
  try{
   const actual=verified||this.entryArtifact(key,reference,{wallMs:remaining(30000)});remaining(30000);
   return {status:'MATERIALIZED',root:this.root,path:`entries/${key}/media${extension}`,sha256:actual.sha256,bytes:actual.bytes,validation:actual.validation,lease_id:leaseId,cache_key:key,reference,scope_status:'CALLER_BOUND',publish_allowed:false,delete_original_allowed:false};
  }catch(error){this.tx(()=>{
   this.db.prepare('DELETE FROM archive_leases WHERE id=?').run(leaseId);
   // A budget/tool failure establishes no corruption. Keep READY, but revalidate on every use.
   const damaged=['ARCHIVE_CACHE_CORRUPT','ARTIFACT_HASH_MISMATCH','ARTIFACT_CHANGED_DURING_READ','INVALID_ARTIFACT_SIZE','VIDEO_DECODE_INVALID','VIDEO_PROBE_INVALID','VIDEO_METADATA_OR_LIMIT_INVALID','VIDEO_STREAMS_UNSUPPORTED','VIDEO_EMPTY_OR_EXCESSIVE_FRAMES'].includes(error.message)||['ENOENT','ENOTDIR','ELOOP'].includes(error.code);
   if(damaged)this.db.prepare("UPDATE archive_cache SET state='CORRUPT' WHERE key=?").run(key);
  });throw error;}
 }
 lease(leaseId,binding,requireReady=true){
  if(typeof leaseId!=='string')fail('ARCHIVE_LEASE_INVALID');
  const row=this.db.prepare('SELECT c.* FROM archive_cache c JOIN archive_leases l ON l.cache_key=c.key WHERE l.id=?').get(leaseId);
  if(!row)fail('ARCHIVE_LEASE_INVALID');const reference=JSON.parse(row.reference_json);scope(reference,binding);if(requireReady&&row.state!=='READY')fail('ARCHIVE_CACHE_CORRUPT');return {...row,reference};
 }
 release(leaseId,{binding}={}){this.tx(()=>{this.lease(leaseId,binding,false);this.db.prepare('DELETE FROM archive_leases WHERE id=?').run(leaseId);});}
 attempts(binding){scope(binding,binding);return this.db.prepare('SELECT id,state,reason,created_at FROM archive_attempts WHERE project_id=? AND account_id=? AND content_id=? ORDER BY created_at,id').all(...scopeKeys.map(k=>binding[k]));}
 sweep(){return this.tx(()=>{
  const removed=[];
  for(const row of this.db.prepare('SELECT * FROM archive_cache').all()){
   if(this.db.prepare('SELECT 1 FROM archive_leases WHERE cache_key=?').get(row.key))continue;
   if(row.state==='BUILDING'){
    try{process.kill(row.owner_pid,0);continue;}catch(error){if(error.code!=='ESRCH')continue;}
   }else if(row.expires_at>this.now())continue;
   const paths=this.paths(row.key,row.stage,extname(JSON.parse(row.reference_json).member_path).toLowerCase());
   rmSync(paths.staging,{recursive:true,force:true});rmSync(paths.entry,{recursive:true,force:true});this.db.prepare('DELETE FROM archive_cache WHERE key=?').run(row.key);if(row.state==='BUILDING')this.db.prepare("UPDATE archive_attempts SET state='INTERRUPTED',reason='ARCHIVE_OWNER_EXITED' WHERE id=?").run(row.stage);removed.push(row.key);
  }return removed;
 });}
 assetKey(assetId,binding){scope(binding,binding);if(!id(assetId))fail('ARCHIVE_ASSET_ID_INVALID');return hash(JSON.stringify([...scopeKeys.map(k=>binding[k]),assetId]));}
 reference(assetId,{binding}={}){
  const row=this.db.prepare('SELECT revision,reference_json,operation FROM archive_reference_history WHERE asset_key=? ORDER BY revision DESC LIMIT 1').get(this.assetKey(assetId,binding));
  if(!row)fail('ARCHIVE_REFERENCE_NOT_FOUND');return {revision:row.revision,reference:JSON.parse(row.reference_json),operation:row.operation,delete_original_allowed:false,publish_allowed:false};
 }
 registerLooseReference(assetId,{binding,root,path,kind,sha256}={}){
  const key=this.assetKey(assetId,binding);if(!kinds.has(kind)||!hex(sha256))fail('ARCHIVE_REFERENCE_INVALID');
  const actual=readProductionArtifact(root,path,kind);if(actual.sha256!==sha256)fail('ARCHIVE_MEMBER_HASH_MISMATCH');
  const reference={type:'LOOSE_FILE',...binding,root:realpathSync(root),path,kind,sha256};
  this.tx(()=>{
   const prior=this.db.prepare('SELECT reference_json FROM archive_reference_history WHERE asset_key=? ORDER BY revision DESC LIMIT 1').get(key);
   if(prior){if(prior.reference_json!==JSON.stringify(reference))fail('ARCHIVE_REFERENCE_CONFLICT');return;}
   this.db.prepare('INSERT INTO archive_reference_history VALUES(?,?,?,?,?)').run(key,1,JSON.stringify(reference),'REGISTER_LOOSE',this.now());
  });return this.reference(assetId,{binding});
 }
 migrateReference(assetId,{binding,leaseId,expectedRevision}={}){
  const key=this.assetKey(assetId,binding);
  return this.tx(()=>{
   const current=this.reference(assetId,{binding}),lease=this.lease(leaseId,binding);
   if(current.revision!==expectedRevision)fail('ARCHIVE_REFERENCE_CONFLICT');
   if(current.reference.sha256!==lease.reference.sha256||current.reference.kind!==lease.reference.kind)fail('ARCHIVE_MIGRATION_BYTES_CHANGED');
   this.entryArtifact(lease.key,lease.reference);
   this.db.prepare('INSERT INTO archive_reference_history VALUES(?,?,?,?,?)').run(key,current.revision+1,JSON.stringify(lease.reference),'MIGRATE_TO_ARCHIVE',this.now());
   return this.reference(assetId,{binding});
  });
 }
 rollbackReference(assetId,{binding,expectedRevision,toRevision}={}){
  const key=this.assetKey(assetId,binding);
  return this.tx(()=>{
   const current=this.reference(assetId,{binding});if(current.revision!==expectedRevision||!Number.isSafeInteger(toRevision)||toRevision<1||toRevision>=expectedRevision)fail('ARCHIVE_REFERENCE_CONFLICT');
   const old=this.db.prepare('SELECT reference_json FROM archive_reference_history WHERE asset_key=? AND revision=?').get(key,toRevision);if(!old)fail('ARCHIVE_REFERENCE_NOT_FOUND');
   this.db.prepare('INSERT INTO archive_reference_history VALUES(?,?,?,?,?)').run(key,current.revision+1,old.reference_json,'ROLLBACK_REFERENCE',this.now());return this.reference(assetId,{binding});
  });
 }
 close(){this.db.close();}
}
