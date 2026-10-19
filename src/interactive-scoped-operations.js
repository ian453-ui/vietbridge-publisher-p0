import {ScopedOperations} from './scoped-operations.js';
import {scopeDigest} from './task-action-permit.js';

/** Per-click authority for the existing authenticated group and interaction UI.
 * A capability is only a preview. The exact permit is issued in the original
 * job claim transaction after the administrator confirms its frozen scope.
 */
export class InteractiveScopedOperations {
 constructor(executor,facebook,{accountId,additionalHistory,mediaRoots,snapshotRoot,now=()=>Date.now()}={}){
  this.executor=executor;this.facebook=facebook;this.accountId=accountId;this.additionalHistory=additionalHistory;this.mediaRoots=mediaRoots;this.snapshotRoot=snapshotRoot;this.now=now;
  const account=executor.publisher.store.db.prepare('SELECT * FROM facebook_accounts WHERE id=?').get(accountId);
  if(!account||!account.enabled||!/^[1-9]\d*$/.test(account.operator_actor_id||'')||!/^[1-9]\d*$/.test(account.target_page_id||'')||account.profile_id?.startsWith('bsk:'))throw Error('INTERACTIVE_SCOPED_EXACT_BROWSER_ACCOUNT_REQUIRED');
  this.policy={workspace:account.workspace,account_id:account.id,actor_id:account.operator_actor_id,target_page_id:account.target_page_id};
 }
 policyFor(kind,id,authorization){return {...this.policy,operations:[kind],interactive_ui:true,additional_history:this.additionalHistory,expires_at:(Math.floor(this.now()/3600000)+1)*3600000,authorization:authorization||{task_id:`publisher-ui:${kind}:${id}`,approval_thread_id:'authenticated-admin-preview',approval_message_id:'preview-only'}};}
 make(kind,id,reply,authorization){
  if(!['GROUP','INTERACTION'].includes(kind)||typeof id!=='string'||!id)throw Error('INTERACTIVE_SCOPE_KIND_OR_ID_REQUIRED');
  const store=this.executor.publisher.store,subject=kind==='GROUP'?store.job(this.policy.workspace,id):store.proactivePost(this.policy.workspace,id);
  if(subject.account_id!==this.accountId)throw Error('OUTSIDE_EXACT_ACCOUNT');
  const ops=new ScopedOperations(this.executor,this.facebook,{policy:this.policyFor(kind,id,authorization),mediaRoots:this.mediaRoots,snapshotRoot:this.snapshotRoot,now:this.now});
  const described=ops.describe(kind,id,reply),scopeHash=scopeDigest(described.scope);
  ops.policy.approved_targets=[{subject_id:`${kind}:${id}`,scope_hash:scopeHash}];
  return ops;
 }
 capability(kind,id,reply){try{return this.make(kind,id,reply).capability(kind,id,reply);}catch(error){return {canExecute:false,mode:'TASK_CONFIRM',reason:error.message};}}
 status(){const account=this.executor.publisher.store.account(this.policy.workspace,this.accountId),ops=new ScopedOperations(this.executor,this.facebook,{policy:this.policyFor('GROUP','status'),mediaRoots:this.mediaRoots,snapshotRoot:this.snapshotRoot,now:this.now});if(account.operator_actor_id!==this.policy.actor_id||account.target_page_id!==this.policy.target_page_id)return {pending:true,error:'ACCOUNT_IDENTITY_CHANGED'};return ops.status();}
 recoverStartup(){for(const kind of ['GROUP','INTERACTION']){const ops=new ScopedOperations(this.executor,this.facebook,{policy:this.policyFor(kind,'recovery'),mediaRoots:this.mediaRoots,snapshotRoot:this.snapshotRoot,now:this.now});ops.recoverStartup();}}
 async executeGroup(workspace,id,input,auth){return this.make('GROUP',id,undefined,auth).executeGroup(workspace,id,input);}
 async executeInteraction(workspace,id,input,auth){return this.make('INTERACTION',id,input.reply_body,auth).executeInteraction(workspace,id,input);}
}
