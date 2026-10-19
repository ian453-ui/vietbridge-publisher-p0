import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,realpathSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,existsSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {boundedRead} from './publisher-core/facebook-readiness-observation.ts';
import {executionScope} from './single-execution-permit.js';
import {chromeCommandMatchesProfile} from './facebook-browser.js';
const exec=promisify(execFile),CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fail=code=>{throw Error(code);};
const equal=(a,b)=>a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
/** ps output is metadata, not shell code. Only provable absolute directory arguments are supported. */
function profileFlag(command,name){
 const pattern=new RegExp('(?:^|\\s)--'+name+'(?:=|\\s+)','g'),matches=[...command.matchAll(pattern)];
 if(matches.length>1||!matches.length&&command.includes('--'+name))fail('BROWSER_REOPEN_PROCESS_ARGUMENTS_UNVERIFIED');
 if(!matches.length)return null;
 const tail=command.slice(matches[0].index+matches[0][0].length);let value;
 if(tail[0]==='"'||tail[0]==="'"){const end=tail.indexOf(tail[0],1);if(end<0||tail.slice(1,end).includes('\\')||tail[end+1]&&!/\s/.test(tail[end+1]))fail('BROWSER_REOPEN_PROCESS_ARGUMENTS_UNVERIFIED');value=tail.slice(1,end);}
 else{const boundary=tail.search(/\s+(?:--[a-zA-Z]|https?:\/\/|about:|chrome:\/\/)/);value=(boundary<0?tail:tail.slice(0,boundary)).trim();if(/["'\\]/.test(value))fail('BROWSER_REOPEN_PROCESS_ARGUMENTS_UNVERIFIED');}
 if(!value)fail('BROWSER_REOPEN_PROCESS_ARGUMENTS_UNVERIFIED');return value;
}
// Filesystem entity IDs, not realpath spelling, establish directory independence.
// bigint avoids lossy device/inode comparisons; only directory metadata is read.
function directoryIdentity(path){
 if(!isAbsolute(path||''))fail('BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED');
 try{const stat=lstatSync(realpathSync(path),{bigint:true});if(!stat.isDirectory()||typeof stat.dev!=='bigint'||stat.dev<0n||typeof stat.ino!=='bigint'||stat.ino<=0n)fail('BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED');return {dev:stat.dev,ino:stat.ino};}catch{fail('BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED');}
}
export function chromeProcessConflicts(process,scope){
 const command=String(process.command||'').trim();if(command!==CHROME&&!command.startsWith(CHROME+' '))fail('BROWSER_REOPEN_PROCESS_ARGUMENTS_UNVERIFIED');
 const port=profileFlag(command,'remote-debugging-port');if(port!==null){if(!/^\d+$/.test(port)||Number(port)>65535)fail('BROWSER_REOPEN_PROCESS_ARGUMENTS_UNVERIFIED');if(Number(port)===scope.cdp_port)return true;}
 const directory=profileFlag(command,'user-data-dir');
 // ps alone cannot prove cwd, environment or official default-directory ownership.
 // Same-user singleton links/socket ownership are copyable and do not bind a data root.
 // An absent flag is unknown, never evidence of an independent profile.
 if(directory===null)fail('BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED');
 const existing=directoryIdentity(directory),frozen=directoryIdentity(scope.profile_dir);
 return existing.dev===frozen.dev&&existing.ino===frozen.ino;
}
export async function reopenProcessState(scope,{run=exec}={}){
 const {stdout}=await run('/bin/ps',['-ww','-axo','pid=,comm='],{timeout:2500});const chrome=[];
 for(const line of stdout.split('\n')){const m=line.trim().match(/^(\d+)\s+(.+)$/);if(m&&m[2]===CHROME){const p=await run('/bin/ps',['-ww','-p',m[1],'-o','command='],{timeout:1000});chrome.push({pid:Number(m[1]),command:p.stdout.trim()});}}
 let output='';try{output=(await run('/usr/sbin/lsof',['-nP','-F','pn','-iTCP:'+scope.cdp_port,'-sTCP:LISTEN'],{timeout:2500})).stdout;}catch(e){if(e.code!==1)throw e;}
 const listeners=[];let pid;for(const line of output.split('\n')){if(/^p\d+$/.test(line))pid=Number(line.slice(1));if(line.startsWith('n'))listeners.push({pid,address:line.slice(1)});}
 return {chrome,listeners};
}
export class BrowserProfileReopen {
 constructor(executor,facebook,authorization,dataDir,{now=()=>Date.now(),processState=reopenProcessState,launch=args=>{const child=spawn(CHROME,args,{detached:true,stdio:'ignore'});child.unref();return new Promise((resolve,reject)=>{child.once('spawn',()=>resolve(child.pid));child.once('error',()=>reject(Error('BROWSER_REOPEN_SPAWN_FAILED')));});},sleep=ms=>new Promise(r=>setTimeout(r,ms)),budgetMs=10000,preflight=snapshot=>facebook.assertDiagnosticProfile(snapshot)}={}){
  Object.assign(this,{executor,facebook,authorization,dataDir,now,processState,launch,sleep,budgetMs,preflight});this.busy=false;this.validateAuthorization(false);
  if(!isAbsolute(dataDir||''))fail('BROWSER_REOPEN_PRIVATE_DATA_REQUIRED');this.directory=join(dataDir,'browser-maintenance');
  const a=authorization;this.marker=join(this.directory,'reopen-'+createHash('sha256').update(JSON.stringify([a.approval_thread_id,a.approval_message_id,Object.entries(a.scope).sort((x,y)=>x[0].localeCompare(y[0]))])).digest('hex')+'.json');
 }
 validateAuthorization(current=true){const a=this.authorization;if(!a||a.version!==1||a.operation!=='REOPEN_EXISTING_BROWSER_PROFILE'||Object.keys(a).sort().join(',')!=='approval_message_id,approval_thread_id,attempt_id,expires_at,id,issued_at,operation,scope,task_id,version'||!/^[-a-zA-Z0-9_]{1,100}$/.test(a.id||'')||![a.task_id,a.approval_thread_id,a.approval_message_id,a.attempt_id].every(v=>typeof v==='string'&&v.trim())||!Number.isSafeInteger(a.issued_at)||!Number.isSafeInteger(a.expires_at)||a.expires_at<=a.issued_at||a.expires_at-a.issued_at>900000||current&&(this.now()<a.issued_at||this.now()>=a.expires_at))fail('BROWSER_REOPEN_AUTHORIZATION_INVALID');}
 bound(workspace=this.authorization.scope.workspace,id=this.authorization.scope.job_id){
  this.validateAuthorization();const a=this.authorization,s=a.scope;if(workspace!==s.workspace||id!==s.job_id)fail('BROWSER_REOPEN_OUTSIDE_SCOPE');
  const job=this.executor.publisher.job(workspace,id),expected={...executionScope(job),profile_id:job.snapshot.profileId,profile_dir:job.snapshot.profileDir,cdp_port:job.snapshot.cdpPort};
  if(!equal(s,expected)||job.state!=='UNKNOWN'||job.attempt_id!==a.attempt_id||s.platform!=='facebook'||s.transport!=='BROWSER'||!Number.isInteger(s.cdp_port)||s.cdp_port<1024||s.cdp_port>65535||!isAbsolute(s.profile_dir))fail('BROWSER_REOPEN_FROZEN_SCOPE_MISMATCH');
  const profile=this.executor.publisher.db.prepare('SELECT * FROM execution_profiles WHERE id=? AND workspace=?').get(s.profile_id,workspace),account=this.executor.publisher.db.prepare('SELECT * FROM facebook_accounts WHERE id=? AND workspace=?').get(s.account_id,workspace);
  if(!profile||!account||profile.cdp_port!==s.cdp_port||profile.user_data_dir!==s.profile_dir||account.profile_id!==s.profile_id||account.operator_actor_id!==s.operator_actor_id||account.external_id!==s.operator_actor_id||account.target_page_id!==s.target_page_id)fail('BROWSER_REOPEN_CURRENT_MAPPING_MISMATCH');
  const stat=lstatSync(s.profile_dir);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(s.profile_dir)!==s.profile_dir)fail('BROWSER_REOPEN_EXISTING_DIRECTORY_REQUIRED');return job;
 }
 state(){if(!existsSync(this.directory))return null;this.privateDirectory();if(!existsSync(this.marker))return null;const st=lstatSync(this.marker);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||process.getuid&&st.uid!==process.getuid())fail('BROWSER_REOPEN_STATE_UNAVAILABLE');const value=JSON.parse(readFileSync(this.marker,'utf8'));if(!['ATTEMPTED','STARTED','BLOCKED'].includes(value.stage))fail('BROWSER_REOPEN_STATE_UNAVAILABLE');return value;}
 privateDirectory(){const st=lstatSync(this.directory);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o777)!==0o700||process.getuid&&st.uid!==process.getuid())fail('BROWSER_REOPEN_STATE_UNAVAILABLE');}
 view(workspace,id){if(workspace!==this.authorization.scope.workspace||id!==this.authorization.scope.job_id)return {state:'UNAVAILABLE'};try{this.bound(workspace,id);const state=this.state();return {state:state?.stage||'AVAILABLE',authorizationId:this.authorization.id,expiresAt:new Date(this.authorization.expires_at).toISOString(),scope:this.authorization.scope,attemptId:this.authorization.attempt_id,...(state?{result:state}:{})};}catch{return {state:'UNAVAILABLE',reason:'重开权限已失效或当前冻结范围不匹配'};}}
 validateInput(workspace,id,input){this.bound(workspace,id);if(Object.keys(input).sort().join(',')!=='attempt_id,authorization_id,confirm,scope'||input.confirm!==true||input.authorization_id!==this.authorization.id||input.attempt_id!==this.authorization.attempt_id||!equal(input.scope,this.authorization.scope))fail('BROWSER_REOPEN_EXACT_CONFIRMATION_REQUIRED');}
 idleAndLease(){const s=this.authorization.scope,db=this.executor.publisher.db;if(this.executor.active.has(s.profile_id))fail('BROWSER_REOPEN_ACTIVE_PROFILE');for(const table of ['publisher_diagnostic_runs','publisher_composer_observations'])if(db.prepare('SELECT 1 FROM '+table+" WHERE state='RUNNING'").get())fail('BROWSER_REOPEN_ACTIVE_DIAGNOSTIC');if(db.prepare("SELECT 1 FROM publisher_jobs WHERE state IN ('PREPARING','SUBMITTING')").get()||db.prepare("SELECT 1 FROM group_jobs WHERE state IN ('PREPARING','PROCESSING','WAITING_FOR_USER')").get()||db.prepare("SELECT 1 FROM engagement_actions WHERE state='ATTEMPTING'").get())fail('BROWSER_REOPEN_ACTIVE_OPERATION');
  const key=createHash('sha256').update(s.profile_dir).digest('hex'),path=join(this.executor.resources.directory,key),file=join(path,'owner.json');if(!existsSync(file)||existsSync(join(path,'readback')))fail('BROWSER_REOPEN_PENDING_LEASE_REQUIRED');const bytes=readFileSync(file),v=JSON.parse(bytes);if(v.resource!==s.profile_dir||v.owner!=='operator:'+s.profile_id||v.phase!=='PENDING'||alive(v.pid))fail('BROWSER_REOPEN_PENDING_LEASE_REQUIRED');return {file,bytes,path};
 }
 persist(value,claim=false){if(!existsSync(this.directory))mkdirSync(this.directory,{mode:0o700});this.privateDirectory();if(claim){const fd=openSync(this.marker,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}}else{const temp=this.marker+'.next';const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,this.marker);}const fd=openSync(this.directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
 async start(workspace,id,input){this.validateInput(workspace,id,input);if(this.busy||this.state())fail('BROWSER_REOPEN_ALREADY_ATTEMPTED');this.busy=true;let claimed=false,lease,pid,readback,readbackToken;
  try{lease=this.idleAndLease();const s=this.authorization.scope,before=await boundedRead(()=>this.processState(s),4500);if(before.listeners.length||before.chrome.some(p=>chromeProcessConflicts(p,s)))fail('BROWSER_REOPEN_PROCESS_CONFLICT');this.validateInput(workspace,id,input);this.idleAndLease();
   const candidate=join(lease.path,'readback');mkdirSync(candidate,{mode:0o700});readback=candidate;readbackToken=randomUUID();writeFileSync(join(readback,'reopen-owner.json'),readbackToken,{flag:'wx',mode:0o600});
   this.persist({authorizationId:this.authorization.id,stage:'ATTEMPTED',at:new Date(this.now()).toISOString()},true);claimed=true;this.executor.active.add(s.profile_id);
   this.validateInput(workspace,id,input);pid=await boundedRead(()=>this.launch(['--remote-debugging-port='+s.cdp_port,'--remote-debugging-address=127.0.0.1','--user-data-dir='+s.profile_dir,'--no-first-run','about:blank']),2500);
   const deadline=Date.now()+this.budgetMs;let ready=false;while(Date.now()<deadline){const live=await boundedRead(()=>this.processState(s),4500);if(live.listeners.length){if(live.listeners.some(l=>l.pid!==pid||!['127.0.0.1:'+s.cdp_port,'[::1]:'+s.cdp_port].includes(l.address))||!live.chrome.some(p=>p.pid===pid&&chromeCommandMatchesProfile(p.command,{cdp_port:s.cdp_port,user_data_dir:s.profile_dir})))fail('BROWSER_REOPEN_BOUND_ENDPOINT_MISMATCH');ready=true;break;}await this.sleep(150);}
   if(!ready)fail('BROWSER_REOPEN_START_TIMEOUT_NO_FORCE');this.bound(workspace,id);await boundedRead(()=>this.preflight(this.executor.publisher.job(workspace,id).snapshot),7000);if(!readFileSync(lease.file).equals(lease.bytes))fail('BROWSER_REOPEN_LEASE_CHANGED');const result={authorizationId:this.authorization.id,stage:'STARTED',at:new Date(this.now()).toISOString(),pid,port:s.cdp_port,loopbackOnly:true,driverPreflight:true};this.persist(result);return result;
  }catch(error){if(claimed)this.persist({authorizationId:this.authorization.id,stage:'BLOCKED',at:new Date(this.now()).toISOString(),...(pid?{pid}:{}),error:/^BROWSER_REOPEN_[A-Z_]+$/.test(error?.message||'')?error.message:'BROWSER_REOPEN_FAILED_NO_RETRY'});throw Error(/^BROWSER_REOPEN_[A-Z_]+$/.test(error?.message||'')?error.message:'BROWSER_REOPEN_FAILED_NO_RETRY');}
  finally{this.busy=false;if(claimed)this.executor.active.delete(this.authorization.scope.profile_id);if(readback){if(readFileSync(join(readback,'reopen-owner.json'),'utf8')!==readbackToken)fail('BROWSER_REOPEN_READBACK_OWNERSHIP_CHANGED');unlinkSync(join(readback,'reopen-owner.json'));rmdirSync(readback);}}
 }
}
