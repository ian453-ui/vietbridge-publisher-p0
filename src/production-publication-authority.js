import {sourceDigest} from './production-source-state.js';

/** Read-only evidence. Never issues, consumes, renews or substitutes for an execution permit. */
export function observePublicationAuthority(executor,workspace,accountId,jobId){
 const job=executor.publisher.job(workspace,jobId);
 if(job.account_id!==accountId)throw Error('PUBLICATION_AUTHORITY_SCOPE_DENIED');
 const binding={job_id:job.id,workspace:job.workspace,account_id:job.account_id,platform:job.snapshot.platform,snapshot_hash:job.snapshot_hash,content_id:job.content_id};
 const base={binding,binding_hash:sourceDigest(binding),observation_only:true,publish_allowed:false,can_execute:false};
 const legacy=executor.permits.record(job.id);
 // Any original single-use record wins, including expired/revoked/consumed records.
 if(legacy){const capability=executor.executionCapability(workspace,job.id);return {...base,mechanism:'SINGLE_EXECUTION_PERMIT',record_id:legacy.id,status:legacy.status,authorization_hash:sourceDigest(JSON.parse(legacy.authorization_json)),eligible:capability.canExecute===true,reason:capability.reason||null};}
 if(executor.scopedOperations){const cap=executor.scopedOperations.capability('PAGE',job.id),row=executor.scopedOperations.permits.read('PAGE:'+job.id),execution=executor.executionCapability(workspace,job.id);return {...base,mechanism:'SCOPED_OPERATIONS',record_id:row?.id??null,status:row?.status||'EXACT_CONFIRMATION_REQUIRED',scope_hash:cap.scopeHash||null,eligible:cap.canExecute===true&&execution.canExecute===true,reason:cap.reason||execution.reason||null};}
 return {...base,mechanism:'NONE',status:'UNAVAILABLE',eligible:false,reason:'EXISTING_EXACT_PUBLICATION_AUTHORITY_REQUIRED'};
}
