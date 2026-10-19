import {realpathSync} from 'node:fs';
import {isAbsolute,relative} from 'node:path';
import {operatingSettingsView} from './operating-settings.mjs';
const fail=m=>{throw Error(m);};
const exact=(input,keys)=>Object.keys(input).every(k=>keys.includes(k));
export function validateInteractionFlow(config){
 const f=config.interactionFlow,p=config.scopeAuthorization,b=config.browserSkillBinding;
 if(!f||Object.keys(f).sort().join(',')!=='group_ids,version'||f.version!==1||!Array.isArray(f.group_ids)||!f.group_ids.length||f.group_ids.length>2||new Set(f.group_ids).size!==f.group_ids.length||f.group_ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))||!b||p?.operations?.join(',')!=='INTERACTION'||p.profile_id!=='bsk:'+b.browser_instance_id||p.workspace!==b.workspace||p.account_id!==b.account_id||p.actor_id!==b.actor_id||p.target_page_id!==b.target_page_id)fail('EXACT_BSK_INTERACTION_FLOW_REQUIRED');
 return [...f.group_ids];
}
export function makeGuard(config,{describe,verifyPreparation,now=()=>Date.now()}){
 const p=config.scopeAuthorization,targets=config.targets,preparations=config.preparations||[],flow=config.interactionFlow?validateInteractionFlow(config):null;
 if(config.version!==1||!p||!Array.isArray(targets)||targets.length>6||(!targets.length&&!preparations.length&&!flow)||targets.some(t=>!['PAGE','GROUP','INTERACTION'].includes(t.kind)||!t.id||!/^[a-f0-9]{64}$/.test(t.scope_hash))||new Set(targets.map(t=>t.kind+':'+t.id)).size!==targets.length)fail('EXACT_MAINTENANCE_TARGETS_REQUIRED');
 const ws=encodeURIComponent(p.workspace),page='/api/unified/workspaces/'+ws,base='/api/workspaces/'+ws,posts=new Map();
 for(const t of targets){
  if(t.kind==='PAGE'){posts.set(page+'/jobs/'+encodeURIComponent(t.id)+'/execute',t);if(t.snapshot_hash)posts.set(page+'/jobs/'+encodeURIComponent(t.id)+'/approve',{...t,approval:true});}
  if(t.kind==='GROUP')posts.set(base+'/group-jobs/'+encodeURIComponent(t.id)+'/execution-capability',{...t,read:true});
  if(t.kind==='INTERACTION')for(const action of ['execution-capability','execute'])posts.set(base+'/proactive/posts/'+encodeURIComponent(t.id)+'/'+action,{...t,read:action==='execution-capability'});
 }
 if(preparations.some(x=>!['PAGE','GROUP'].includes(x.kind)||!p.operations.includes(x.kind)||!x.content_id||!/^[a-f0-9]{64}$/.test(x.content_hash||'')||!/^[a-f0-9]{64}$/.test(x.body_hash||'')||!Array.isArray(x.media_hashes)||x.kind==='PAGE'&&(!x.payload||typeof x.payload.body!=='string')||x.kind==='GROUP'&&(!Array.isArray(x.groups)||!x.groups.length||x.groups.length>2||new Set(x.groups.map(g=>g.id)).size!==x.groups.length)))fail('EXACT_PREPARATION_SCOPE_REQUIRED');
 const prepPaths=new Map(preparations.map(x=>[x.kind==='PAGE'?page+'/jobs':base+'/group-jobs',x]));if(prepPaths.size!==preparations.length||preparations.some(x=>!['PAGE','GROUP'].includes(x.kind)))fail('EXACT_PREPARATION_SCOPE_REQUIRED');
 const groupPath=base+'/group-jobs/auto-publish',selectPaths=new Set([base+'/accounts/select',page+'/accounts/select']);
 const requestGuard=({url,input,principal})=>{
  // Runs after the original Host/auth/Origin/CSRF/body validations, never instead.
  if(principal?.type!=='admin')fail('SCOPED_ADMINISTRATOR_REQUIRED');
  if(url.pathname==='/api/access/logout'){if(Object.keys(input).length)fail('MAINTENANCE_LOGOUT_INVALID');return;}
  if(selectPaths.has(url.pathname)){if(!exact(input,['id'])||input.id!==p.account_id)fail('SCOPED_ACCOUNT_SELECTION_MISMATCH');return;}
  const preparation=prepPaths.get(url.pathname);if(preparation){if(now()>=p.expires_at)fail('SCOPED_WINDOW_EXPIRED');if(typeof verifyPreparation!=='function')fail('PREPARATION_VERIFIER_REQUIRED');verifyPreparation(preparation,input);return;}
  let target=posts.get(url.pathname);
  if(flow){const m=url.pathname.match(new RegExp('^'+base+'/proactive/posts/([a-f0-9-]{36})/(execution-capability|execute)$'));if(m)target={kind:'INTERACTION',id:m[1],read:m[2]==='execution-capability',dynamic:true};}
  if(url.pathname===groupPath){if(!Array.isArray(input.job_ids)||input.job_ids.length!==1)fail('CONFIRM_EXACTLY_ONE_APPROVED_GROUP_JOB');target=targets.find(t=>t.kind==='GROUP'&&t.id===input.job_ids[0]);}
  if(!target)fail('MAINTENANCE_READ_ONLY');if(now()>=p.expires_at)fail('SCOPED_WINDOW_EXPIRED');
  if(target.approval&&(!exact(input,['snapshot_hash'])||input.snapshot_hash!==target.snapshot_hash))fail('MAINTENANCE_FROZEN_APPROVAL_MISMATCH');
  const observed=describe(target.kind,target.id,input.reply_body,{approvalOnly:!!target.approval});
  if(target.dynamic)target={...target,scope_hash:observed.scopeHash};else if(observed.scopeHash!==target.scope_hash)fail('MAINTENANCE_FROZEN_SCOPE_MISMATCH');
  if(target.approval){if(!exact(input,['snapshot_hash'])||input.snapshot_hash!==target.snapshot_hash)fail('MAINTENANCE_FROZEN_APPROVAL_MISMATCH');return;}
  const keys=target.kind==='INTERACTION'?['reply_body',...(target.read?[]:['confirm','scope_hash',...(config.browserSkillBinding?['ack_group_rules']:[])])]:target.kind==='GROUP'&&!target.read?['job_ids','confirm','scope_hash','ack_group_rules']:target.read?[]:['confirm','scope_hash'];
  if(config.browserSkillBinding&&target.kind==='INTERACTION'&&!target.read&&input.ack_group_rules!==true)fail('EXPLICIT_GROUP_RULES_ACK_REQUIRED');
  if(!exact(input,keys)||!target.read&&(input.confirm!==true||input.scope_hash!==target.scope_hash)||target.kind==='GROUP'&&!target.read&&input.ack_group_rules!==true)fail('MAINTENANCE_EXACT_CONFIRMATION_REQUIRED');
 };
 return {requestGuard,postPaths:new Set([...posts.keys(),...prepPaths.keys(),groupPath,...selectPaths]),dynamicPostAllowed:path=>Boolean(flow&&new RegExp('^'+base+'/proactive/posts/[a-f0-9-]{36}/(?:execution-capability|execute)$').test(path))};
}
// Ordinary local preparation reuses existing business validation; it grants no
// browser, platform, identity, history-rewrite or background authority.
export function localPreparationRoute(path){
 if(/^\/api\/workspaces\/ws-[a-z0-9-]+\/library\/import$/i.test(path))return 'library';
 if(/^\/api\/workspaces\/ws-[a-z0-9-]+\/library\/approve-gpt$/i.test(path))return 'gpt';
 if(/^\/api\/(?:unified\/)?workspaces\/ws-[a-z0-9-]+\/accounts\/select$/i.test(path))return 'select';
 if(/^\/api\/unified\/workspaces\/ws-[a-z0-9-]+\/content$/i.test(path))return 'content';
 if(/^\/api\/unified\/workspaces\/ws-[a-z0-9-]+\/jobs$/i.test(path))return 'draft';
 if(/^\/api\/unified\/workspaces\/ws-[a-z0-9-]+\/jobs\/[a-f0-9-]{36}\/approve$/i.test(path))return 'approve';
 return null;
}
export function guardLocalPreparation({url,input,principal},clientRoot){
 const kind=localPreparationRoute(url.pathname);if(!kind)return false;
 if(principal?.type!=='admin')fail('LOCAL_PREPARATION_ADMIN_REQUIRED');
 const allowed={library:['selections'],gpt:['key','revision','previous_revision'],select:['id'],content:['source_id','revision','title','body','media','platform_payloads'],draft:['account_id','content_id','payload'],approve:['snapshot_hash']}[kind];
 if(url.search||!input||Array.isArray(input)||typeof input!=='object'||!exact(input,allowed))fail('LOCAL_PREPARATION_INPUT_INVALID');
 const text=value=>typeof value==='string'&&Boolean(value.trim());
 if(kind==='library'&&(!Array.isArray(input.selections)||!input.selections.length||input.selections.length>20||input.selections.some(v=>!v||Object.keys(v).sort().join(',')!=='key,revision'||!text(v.key)||!text(v.revision))))fail('LOCAL_PREPARATION_INPUT_INVALID');
 if(kind==='gpt'&&(!/^[a-f0-9]{64}$/.test(input.key||'')||!/^[a-f0-9]{64}$/.test(input.revision||'')||input.previous_revision!==undefined&&!/^[a-f0-9]{64}$/.test(input.previous_revision)))fail('LOCAL_PREPARATION_INPUT_INVALID');
 if(kind==='select'&&!text(input.id)||kind==='draft'&&(!text(input.account_id)||!text(input.content_id))||kind==='content'&&(!text(input.source_id)||!text(input.revision)||!text(input.body)||!Array.isArray(input.media))||kind==='approve'&&!/^[a-f0-9]{64}$/.test(input.snapshot_hash||''))fail('LOCAL_PREPARATION_INPUT_INVALID');
 if(kind==='content'){
  const media=[...input.media,...Object.values(input.platform_payloads||{}).flatMap(value=>Array.isArray(value?.media)?value.media:[])];
  if(media.length){try{const workspace=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)/)[1],root=realpathSync(clientRoot(workspace));for(const path of media){if(typeof path!=='string'||!isAbsolute(path))fail('LOCAL_PREPARATION_MEDIA_INVALID');const rel=relative(root,realpathSync(path));if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('LOCAL_PREPARATION_MEDIA_INVALID');}}catch{fail('LOCAL_PREPARATION_MEDIA_INVALID');}}
 }
 return true;
}
export function restrict(server,sha,{diagnosticPaths=[],postPaths=new Set(),dynamicPostAllowed=()=>false,maintenanceMode='scoped-task-confirmation',localPreparation=false,operatingSettingsScope=null}={}){
 if(!['read-only','scoped-task-confirmation'].includes(maintenanceMode)||!/^[a-f0-9]{40}$/.test(sha)||!Array.isArray(diagnosticPaths)||diagnosticPaths.length>1||diagnosticPaths.some(p=>!/^\/api\/unified\/workspaces\/ws-[a-z0-9-]+\/jobs\/[a-f0-9-]{36}\/diagnostics$/.test(p)))fail('MAINTENANCE_RELEASE_OR_DIAGNOSTIC_SCOPE_INVALID');
 const diagnostics=new Set(diagnosticPaths),handlers=server.listeners('request');server.removeAllListeners('request');
 const safe=new Set(['/','/login','/api/health','/api/state','/api/facebook','/api/group-library','/api/group-library/media','/api/group-library/content-media','/api/content-sync','/api/automation/capabilities','/api/publisher-integration']);
 // Exact static module paths only; api-response is a dependency of client.js.
 // No profile, scan, prepare, reserve, queue or wildcard POST.
 const staticFiles=/^\/(?:client|api-response|unified-client|publisher-form-state|group-selection|group-filters|publisher-access-ui|publication-selection|scoped-confirmation-ui|operating-settings-ui)\.js$|^\/styles\.css$/;
 server.on('request',(req,res)=>{
  res.setHeader('X-Publisher-Deployment-SHA',sha);res.setHeader('X-Publisher-Maintenance',maintenanceMode);
  if(operatingSettingsScope)res.setHeader('X-Publisher-Operating-Settings',encodeURIComponent(JSON.stringify(operatingSettingsView(operatingSettingsScope))));
  const path=new URL(req.url||'/', 'http://127.0.0.1').pathname;
  const read=(req.method==='GET'||req.method==='HEAD')&&(safe.has(path)||staticFiles.test(path)||path.startsWith('/api/unified/'));
  const allowed=req.method==='POST'&&(path==='/auth/login'||path==='/api/access/logout'||diagnostics.has(path)||postPaths.has(path)||dynamicPostAllowed(path)||localPreparation&&localPreparationRoute(path));
  if(!read&&!allowed){res.writeHead(423,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:'MAINTENANCE_READ_ONLY'}));return;}
  for(const handler of handlers)handler.call(server,req,res);
 });
}
