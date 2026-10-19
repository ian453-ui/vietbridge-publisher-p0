import {createHash} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {existsSync,lstatSync,realpathSync,statSync,mkdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';

const fail=code=>{throw Error(code);};
const keys=['workspace','account_id','project_id','manifest_drive_file_id','relative_root','source_root'];
const equal=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const entity=path=>{try{const s=statSync(realpathSync(path),{bigint:true});if(!s.isDirectory()||s.ino<=0n)fail('MANUAL_SYNC_ROOT_UNVERIFIED');return {dev:s.dev,ino:s.ino};}catch{fail('MANUAL_SYNC_ROOT_UNVERIFIED');}};
const safe=e=>/^(?:MANUAL_SYNC|CONTENT_SYNC|GOOGLE_DRIVE|GOOGLE_TOKEN)_[A-Z0-9_]+$/.test(e?.message||'')?e.message:'CONTENT_SYNC_FAILED';

/** One admin-confirmed read-only Drive input run. No OAuth or platform authority. */
export class ContentSyncOnce {
 constructor(getSync,authorization,dataDir,{now=()=>Date.now()}={}){
  Object.assign(this,{getSync,authorization,now});this.busy=false;this.validate(false);
  if(!isAbsolute(dataDir||''))fail('MANUAL_SYNC_PRIVATE_DATA_REQUIRED');
  this.directory=join(dataDir,'manual-content-sync');
  // Changing policy ID, expiry or scope cannot reuse the same approval event.
  this.marker=join(this.directory,createHash('sha256').update(JSON.stringify([authorization.operation,authorization.approval_thread_id,authorization.approval_message_id])).digest('hex')+'.json');
 }
 validate(current=true){
  const a=this.authorization,s=a?.scope;
  if(!a||a.version!==1||a.operation!=='SYNC_EXISTING_DRIVE_SOURCE_ONCE'||Object.keys(a).sort().join(',')!=='approval_message_id,approval_thread_id,expires_at,id,issued_at,operation,scope,version'||typeof a.id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(a.id||'')||![a.approval_thread_id,a.approval_message_id].every(v=>typeof v==='string'&&v.trim()&&!/[<>]/.test(v))||!Number.isSafeInteger(a.issued_at)||!Number.isSafeInteger(a.expires_at)||a.expires_at<=a.issued_at||a.expires_at-a.issued_at>86400000||current&&(this.now()<a.issued_at||this.now()>=a.expires_at))fail('MANUAL_SYNC_AUTHORIZATION_INVALID');
  if(!s||!keys.every(k=>typeof s[k]==='string'&&s[k].trim()&&!/[<>]/.test(s[k]))||Object.keys(s).sort().join(',')!==keys.slice().sort().join(',')||!/^ws-[a-z0-9-]+$/i.test(s.workspace||'')||!s.account_id||!/^[-A-Z0-9]+$/.test(s.project_id||'')||!s.manifest_drive_file_id||!/^clients\/[a-z0-9-]+$/.test(s.relative_root||'')||!isAbsolute(s.source_root||''))fail('MANUAL_SYNC_SCOPE_INVALID');
 }
 bound(){
  this.validate();const a=this.authorization.scope,sync=this.getSync();
  if(!sync||typeof sync.makeClient!=='function')fail('CONTENT_SYNC_CONNECTOR_NOT_CONFIGURED');
  let source;try{source=sync.binding(a.workspace,a.account_id);}catch{fail('MANUAL_SYNC_BINDING_INVALID');}
  if(source.projectId!==a.project_id||source.manifestDriveFileId!==a.manifest_drive_file_id||source.relativeRoot!==a.relative_root)fail('MANUAL_SYNC_SOURCE_CHANGED');
  const root=resolve(sync.library.roots[0],source.relativeRoot),identity=entity(root);if(this.rootIdentity&&!equal(this.rootIdentity,identity))fail('MANUAL_SYNC_ROOT_CHANGED');
  if(!equal(identity,entity(a.source_root))||!equal(identity,entity(sync.library.clientRoot(a.workspace))))fail('MANUAL_SYNC_ROOT_CHANGED');
  const owners=sync.store.list('workspaces').filter(w=>w.content_root&&existsSync(w.content_root)&&equal(entity(w.content_root),identity));
  if(owners.length!==1||owners[0].id!==a.workspace)fail('MANUAL_SYNC_UNIQUE_OWNER_REQUIRED');
  if(sync.automatic||sync.timer)fail('MANUAL_SYNC_PERIODIC_FORBIDDEN');this.rootIdentity??=identity;return sync;
 }
 privateDirectory(){const s=lstatSync(this.directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700||process.getuid&&s.uid!==process.getuid())fail('MANUAL_SYNC_PRIVATE_STATE_REQUIRED');}
 state(){
  if(!existsSync(this.directory))return null;this.privateDirectory();if(!existsSync(this.marker))return null;
  const s=lstatSync(this.marker);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600||process.getuid&&s.uid!==process.getuid())fail('MANUAL_SYNC_PRIVATE_STATE_REQUIRED');
  let value;try{value=JSON.parse(readFileSync(this.marker,'utf8'));}catch{fail('MANUAL_SYNC_PRIVATE_STATE_REQUIRED');}if(!['RUNNING','DONE','BLOCKED'].includes(value.stage))fail('MANUAL_SYNC_PRIVATE_STATE_REQUIRED');return value;
 }
 check(workspace,accountId,input){
  this.bound();const s=this.authorization.scope;
  if(workspace!==s.workspace||accountId!==s.account_id||!input||Object.keys(input).sort().join(',')!=='account_id,workspace'||input.workspace!==s.workspace||input.account_id!==s.account_id)fail('MANUAL_SYNC_EXACT_INPUT_REQUIRED');
  if(this.busy||this.state())fail('MANUAL_SYNC_ALREADY_ATTEMPTED');
  if(this.getSync().inflight?.has(workspace))fail('MANUAL_SYNC_SOURCE_ACTIVE');
 }
 capability(workspace=this.authorization.scope.workspace,accountId=this.authorization.scope.account_id){try{this.check(workspace,accountId,{workspace,account_id:accountId});return {canRun:true,once:true};}catch(e){return {canRun:false,once:true,reason:/^[A-Z][A-Z0-9_]+$/.test(e.message||'')?e.message:'MANUAL_SYNC_UNAVAILABLE'};}}
 persist(value,claim=false){
  if(!existsSync(this.directory))mkdirSync(this.directory,{mode:0o700});this.privateDirectory();
  const file=claim?this.marker:this.marker+'.next';let fd;try{fd=openSync(file,'wx',0o600);}catch(e){if(claim&&e.code==='EEXIST')fail('MANUAL_SYNC_ALREADY_ATTEMPTED');fail('MANUAL_SYNC_PRIVATE_STATE_REQUIRED');}
  try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  if(!claim)renameSync(file,this.marker);const dir=openSync(this.directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 }
 async run(workspace,accountId){
  this.check(workspace,accountId,{workspace,account_id:accountId});
  this.persist({stage:'RUNNING',authorizationId:this.authorization.id,at:new Date(this.now()).toISOString()},true);this.busy=true;
  let sync,previous;
  try{sync=this.bound();previous=sync.beforeRead;sync.beforeRead=()=>{try{previous?.();this.bound();}catch(e){if(/^MANUAL_SYNC_[A-Z0-9_]+$/.test(e?.message||''))throw e;fail('MANUAL_SYNC_BINDING_INVALID');}};const result=await sync.run(workspace,accountId);this.persist({stage:'DONE',authorizationId:this.authorization.id,at:new Date(this.now()).toISOString()});return result;}
  catch(e){this.persist({stage:'BLOCKED',authorizationId:this.authorization.id,at:new Date(this.now()).toISOString(),error:safe(e)});throw Error(safe(e));}
  finally{if(sync)sync.beforeRead=previous;this.busy=false;}
 }
}
