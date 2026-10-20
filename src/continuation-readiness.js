import {guardedStates} from './publisher-platforms.js';

// Normalize only the standard transport spellings of this exact repository.
// Reject credentials, host aliases, ports, query strings and extra path segments.
const repositoryMatches=value=>typeof value==='string' &&
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)ian453-ui\/vietbridge-publisher-p0(?:\.git)?$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const id=value=>typeof value==='string'&&value.trim().length>0;
const evidenceStatus=(e,now)=>{
  if(!e)return 'MISSING';
  const observed=Date.parse(e.observedAt),expires=Date.parse(e.validUntil);
  if(!Number.isFinite(observed)||!Number.isFinite(expires)||expires<=observed)return 'INVALID_TIME_RANGE';
  if(observed>now)return 'FUTURE_OBSERVATION';
  return now>=expires?'EXPIRED':'FRESH';
};
const fresh=(e,now)=>evidenceStatus(e,now)==='FRESH';
const result=reasons=>({status:reasons.length?'BLOCKED':'CHECKABLE',reasons});

/** Advisory only: caller evidence is not authority, a lease, or a publishing permit. */
export function continuationReadiness(input,source,{now=Date.now()}={}) {
  if(input?.version!==1||!Number.isFinite(now))throw Error('INVALID_CONTINUATION_INPUT');
  const owner=[];
  if(!id(input.originalOwner)||!id(input.currentOwner))owner.push('OWNER_EVIDENCE_MISSING');
  else if(input.originalOwner!==input.currentOwner)owner.push('OWNER_CHANGE_NOT_ALLOWED');
  const code=[...owner];
  if(!repositoryMatches(source?.repository)||source?.branch!=='publisher-unified')code.push('SOURCE_IDENTITY_MISMATCH');
  if(!sha(input.targetCommit)||source?.commit!==input.targetCommit)code.push('EXACT_COMMIT_REQUIRED');
  if(source?.clean!==true)code.push('WORKTREE_NOT_CLEAN');
  const mac=[...code];
  if(!fresh(input.mac,now))mac.push('MAC_EVIDENCE_MISSING_OR_EXPIRED');
  if(input.mac?.online!==true)mac.push('MAC_OFFLINE_OR_UNKNOWN');
  if(input.mac?.worktreeClean!==true)mac.push('MAC_LOCAL_CHANGES_OR_UNKNOWN');
  if(input.mac?.preserveDataAndConfig!==true)mac.push('DATA_PRESERVATION_UNCONFIRMED');
  const verify=[...mac];
  if(input.mac?.commit!==input.targetCommit)verify.push('MAC_EXACT_COMMIT_REQUIRED');
  if(input.mac?.localDependenciesVerified!==true)verify.push('LOCAL_DEPENDENCIES_UNVERIFIED');
  const publication=[...owner,'EXISTING_PUBLICATION_CONFIRMATION_REQUIRED'];
  const history=input.history;
  if(!fresh(history,now)||history?.complete!==true||!Array.isArray(history?.jobs))publication.push('HISTORY_INCOMPLETE_OR_EXPIRED');
  if(!id(input.workspace)||!id(input.accountId))publication.push('ACCOUNT_BINDING_MISSING');
  for(const job of Array.isArray(history?.jobs)?history.jobs:[]) {
    if(!job||job.workspace!==input.workspace||job.accountId!==input.accountId){publication.push('HISTORY_SCOPE_MISMATCH');continue;}
    if(job.submitSafetyDomain==='MAY_HAVE_SUBMITTED'||job.preparationEffectsMayRemain===true||[...guardedStates,'RECONCILE_PENDING','SUBMITTED_PENDING_CONFIRMATION','DRAFT_API_WRITTEN_NOT_PUBLISHED'].includes(job.state))publication.push('EXISTING_OR_UNCERTAIN_RESULT_NO_REPLAY');
    else if(!['DRAFT','READY','BLOCKED','CANCELLED','FAILED','FAILED_PREFLIGHT','BLOCKED_CAPABILITY'].includes(job.state))publication.push('UNRECOGNIZED_HISTORY_STATE');
  }
  return {version:1,evidence:{mac:evidenceStatus(input.mac,now),history:evidenceStatus(input.history,now)},advisoryOnly:true,ownerChanged:false,originalOwner:id(input.originalOwner)?input.originalOwner:null,targetCommit:sha(input.targetCommit)?input.targetCommit:null,
    steps:{cloudReviewBuildTest:result(code),macManualSync:result(mac),macLocalVerification:result(verify),publication:{status:'BLOCKED',reasons:[...new Set(publication)]}},
    note:'CHECKABLE means dependencies permit review only; it grants no execution, deployment, owner transfer or publication authority.'};
}
