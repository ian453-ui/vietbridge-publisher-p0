import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const fail=code=>{throw Error(code);};
const keys=['version','workspace','account_id','actor_id','target_page_id','browser_instance_id','issued_at','expires_at','evidence'];
const evidenceKeys=['source','approval_thread_id','approval_message_id'];
export function validateBrowserSkillBinding(binding){
 if(!binding||Object.keys(binding).length!==keys.length||keys.some(k=>!Object.hasOwn(binding,k))||binding.version!==1||!/^ws-[a-z0-9-]+$/i.test(binding.workspace||'')||typeof binding.account_id!=='string'||!binding.account_id.trim()||!/^[a-f0-9]{8}$/.test(binding.browser_instance_id||'')||!['actor_id','target_page_id'].every(k=>/^[1-9]\d*$/.test(binding[k]))||!Number.isSafeInteger(binding.issued_at)||!Number.isSafeInteger(binding.expires_at)||binding.issued_at<0||binding.expires_at<=binding.issued_at||binding.expires_at-binding.issued_at>28800000)fail('BSK_EXACT_FINITE_BINDING_REQUIRED');
 const e=binding.evidence;if(!e||Object.keys(e).length!==evidenceKeys.length||evidenceKeys.some(k=>!Object.hasOwn(e,k))||e.source!=='USER_PROFILE_INSTRUCTIONS'||!['approval_thread_id','approval_message_id'].every(k=>typeof e[k]==='string'&&e[k].trim()&&e[k].length<=200))fail('BSK_USER_SELECTED_INSTANCE_REQUIRED');
 return binding;
}
export function assertBrowserSkillBinding(db,binding,{now=Date.now()}={}){
 validateBrowserSkillBinding(binding);
 if(now<binding.issued_at||now>=binding.expires_at)fail('BSK_BINDING_EXPIRED');
 const account=db.prepare('SELECT * FROM facebook_accounts WHERE workspace=? AND id=?').get(binding.workspace,binding.account_id);
 if(!account?.enabled||account.platform!=='facebook'||account.publisher_transport!=='BROWSER'||account.external_id!==binding.actor_id||account.operator_actor_id!==binding.actor_id||account.target_page_id!==binding.target_page_id)fail('BSK_ACCOUNT_BINDING_CHANGED');
 // Supported extension instance + owned Agent Window is the resource boundary.
 // New interactions neither launch CDP Chrome nor navigate/close old task tabs.
 // Their mapping must never require local Chrome directory access.
 return {profileId:'bsk:'+binding.browser_instance_id,instanceId:binding.browser_instance_id,fingerprint:createHash('sha256').update(JSON.stringify(binding)).digest('hex')};
}

const execFileAsync=promisify(execFile);
/** Commands are argv, never shell. Construction does no IPC and starts nothing. */
export class BrowserSkillClient{
 constructor({executable,run=execFileAsync}={}){if(!isAbsolute(executable||''))fail('BSK_ABSOLUTE_CLI_REQUIRED');this.executable=executable;this.run=run;}
 async command(args){
  let output;try{output=await this.run(this.executable,[...args,'--json'],{env:{...process.env,BSK_AUTO_START:'0'},timeout:50000,maxBuffer:1048576,shell:false});}
  catch{fail('BSK_COMMAND_FAILED_OR_OUTCOME_UNKNOWN');}
  let value;try{value=JSON.parse(output.stdout);}catch{fail('BSK_INVALID_RESPONSE');}
  if(value?.exit_code||value?.ok===false||value?.code)fail('BSK_COMMAND_FAILED_OR_OUTCOME_UNKNOWN');return value;
 }
 async start(instance){
  const status=await this.command(['status']),matches=status.browsers?.filter(b=>b.instance_id===instance)||[];
  if(matches.length!==1||matches[0].unresponsive||matches[0].version_skew)fail('BSK_PINNED_INSTANCE_DISCONNECTED');
  // A different task in this profile could switch its shared Facebook actor.
  if(status.sessions?.some(s=>s.browser_instance_id===instance))fail('BSK_PINNED_INSTANCE_BUSY');
  const s=await this.command(['session','start','--browser',instance,'--no-focus']);
  if(s.browser_instance_id!==instance||!s.session_id||s.interaction?.borrow_confirmation!=='always'||s.interaction?.request_help!=='enabled'){if(s.session_id)await this.stop(s.session_id).catch(()=>{});fail('BSK_SESSION_BINDING_OR_SETTINGS_CHANGED');}
  return s.session_id;
 }
 stop(session){return this.command(['session','stop',session]);}
 async tab(session,url){const r=await this.command(['tab','create','--session',session,'--url',url,'--no-active']);if(!Number.isSafeInteger(r.tab_id))fail('BSK_OWNED_TAB_REQUIRED');return r.tab_id;}
 navigate(session,tab,url){return this.command(['navigate',url,'--session',session,'--tab-id',String(tab),'--wait-until','domcontentloaded']);}
 activate(session,tab){if(!Number.isSafeInteger(tab))fail('BSK_OWNED_TAB_REQUIRED');return this.command(['tab','select',String(tab),'--session',session]);}
 observe(session,tab){return this.command(['observe','--session',session,'--tab-id',String(tab)]);}
 async read(session,tab,fn,args){const r=await this.command(['evaluate','('+fn.toString()+')('+JSON.stringify(args)+')','--session',session,'--tab-id',String(tab)]);if(r.ok!==true||!Object.hasOwn(r,'value'))fail('BSK_VISIBLE_DOM_UNAVAILABLE');return r.value;}
 input(session,tab,command,selector,value){
  if(!['click','fill','press'].includes(command)||typeof selector!=='string'||!selector)fail('BSK_EXACT_CONTROL_REQUIRED');
  const args=[command,...(command==='press'?[value]:[]),'--selector',selector,'--session',session,'--tab-id',String(tab)];if(command==='fill')args.push('--value',value);return this.command(args);
 }
 refInput(session,tab,command,ref,value,{noClear=false}={}){
  if(!['click','fill'].includes(command)||!/^@e[1-9]\d*$/.test(ref))fail('BSK_FRESH_REF_REQUIRED');
  const args=[command,'--ref',ref,'--session',session,'--tab-id',String(tab)];
  if(command==='fill'){args.push('--value',value);if(noClear)args.push('--no-clear');}
  return this.command(args);
 }
 upload(session,tab,ref,path){
  if(!/^@e[1-9]\d*$/.test(ref)||!isAbsolute(path||''))fail('BSK_EXPLICIT_UPLOAD_REQUIRED');
  // One input mechanism only; unknown/committed effects never auto-retry/drop.
  return this.command(['upload','--ref',ref,'--file',path,'--session',session,'--tab-id',String(tab),'--timeout','30s']);
 }
 closeTab(session,tab){return this.command(['tab','close',String(tab),'--session',session]);}
}
