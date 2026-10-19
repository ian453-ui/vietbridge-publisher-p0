import {mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync,openSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {resolve,join,dirname,basename,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

function physical(path){let base=resolve(path),tail=[];while(!existsSync(base)){tail.unshift(basename(base));base=dirname(base);}return resolve(realpathSync(base),...tail);}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function sync(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function persist(file,record){const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(record),{mode:0o600});sync(temp);renameSync(temp,file);sync(dirname(file));sync(dirname(dirname(file)));}

// Durable, fail-closed browser exclusion; no database records are shared/copied.
export class BrowserResources {
 constructor(directory){if(!isAbsolute(directory))throw Error('BROWSER_RESOURCE_DIRECTORY_REQUIRED');this.directory=directory;this.active=new Set();mkdirSync(directory,{recursive:true,mode:0o700});}
 acquire(profilePath,owner,pending,options={}){return this.acquireResource(physical(profilePath),owner,pending,options);}
 acquireInstance(instanceId,owner,pending){if(!/^[a-f0-9]{8}$/.test(instanceId||''))throw Error('BROWSER_EXACT_INSTANCE_REQUIRED');return this.acquireResource('browser-skill-instance:'+instanceId,owner,pending);}
 acquireResource(resource,owner,pending,{reconcile=false}={}){
  const key=createHash('sha256').update(resource).digest('hex'),path=join(this.directory,key),file=join(path,'owner.json');
  if(this.active.has(resource))throw Error('BROWSER_RESOURCE_BUSY');
  let record={resource,owner,token:randomUUID(),pid:process.pid,phase:'ACTIVE'};
  try{mkdirSync(path,{mode:0o700});persist(file,record);}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   const old=JSON.parse(readFileSync(file,'utf8'));
   if(!reconcile||old.owner!==owner||old.phase==='ACTIVE'&&alive(old.pid))throw Error('BROWSER_RECONCILIATION_REQUIRED');
   // Another process cannot reconcile the same outstanding lease concurrently.
   try{mkdirSync(join(path,'readback'),{mode:0o700});}catch{throw Error('BROWSER_RESOURCE_BUSY');}
   record=old;
  }
  this.active.add(resource);let released=false;
  return ()=>{
   if(released)return;released=true;this.active.delete(resource);
   const current=JSON.parse(readFileSync(file,'utf8'));if(current.token!==record.token)throw Error('BROWSER_STALE_LEASE');
   if(pending()){persist(file,{...record,phase:'PENDING'});rmSync(join(path,'readback'),{recursive:true,force:true});}
   else {rmSync(path,{recursive:true});sync(this.directory);}
  };
 }
}
