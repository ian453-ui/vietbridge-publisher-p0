const keys=['version','kind','subject_id','workspace','account_id','actor_id','target_page_id','target_id','platform','transport','profile_id','snapshot_hash','body_hash','media_hashes','actions'];
const fail=message=>{throw Error(message);};
export function taskActionScopeEntries(scope){
 if(!scope||Object.keys(scope).length!==keys.length||keys.some(k=>!Object.hasOwn(scope,k)))fail('EXACT_SCOPE_REQUIRED');
 if(scope.version!==1||!['PAGE','GROUP','INTERACTION'].includes(scope.kind)||scope.platform!=='facebook'||!['BROWSER','BROWSER_SKILL'].includes(scope.transport)||scope.transport==='BROWSER_SKILL'&&!/^bsk:[a-f0-9]{8}$/.test(scope.profile_id||''))fail('UNSUPPORTED_SCOPE');
 for(const k of ['subject_id','workspace','account_id','profile_id'])if(typeof scope[k]!=='string'||!scope[k].trim())fail('INVALID_SCOPE_ID');
 if(scope.transport==='BROWSER_SKILL'&&!scope.subject_id.startsWith(scope.kind+':'))fail('UNSUPPORTED_SCOPE_SUBJECT');
 for(const k of ['actor_id','target_page_id','target_id'])if(!/^[1-9]\d*$/.test(scope[k]))fail('REAL_PLATFORM_ID_REQUIRED');
 for(const k of ['snapshot_hash','body_hash'])if(!/^[a-f0-9]{64}$/.test(scope[k]))fail('FROZEN_HASH_REQUIRED');
 if(!Array.isArray(scope.media_hashes)||scope.media_hashes.some(v=>!v||Object.keys(v).sort().join(',')!=='ordinal,sha256,size'||!Number.isSafeInteger(v.ordinal)||v.ordinal<0||!Number.isSafeInteger(v.size)||v.size<1||!/^[a-f0-9]{64}$/.test(v.sha256))||scope.media_hashes.some((v,i)=>v.ordinal!==i))fail('ORDERED_MEDIA_HASHES_REQUIRED');
 const actions=scope.actions;if(!Array.isArray(actions)||!actions.length||new Set(actions).size!==actions.length||actions.some(a=>!['PUBLISH','LIKE','INITIAL_REPLY'].includes(a)))fail('EXACT_ACTIONS_REQUIRED');
 if(scope.kind==='INTERACTION'){if(scope.media_hashes.length||actions.includes('PUBLISH')||actions.join(',')!==['LIKE','INITIAL_REPLY'].filter(a=>actions.includes(a)).join(','))fail('INVALID_INTERACTION_ACTIONS');}
 else if(actions.join(',')!=='PUBLISH')fail('INVALID_PUBLISH_ACTIONS');
 if(scope.kind==='PAGE'&&scope.target_id!==scope.target_page_id)fail('PAGE_TARGET_MISMATCH');
 return keys.map(k=>[k,scope[k]]);
}

// Existing scoped-operations limits, shared without increasing them.
export const scopedOperationLimits=Object.freeze({page:1,groups:2,groupPosts:1,interactionActions:3});
export const taskActionDedupValue=(scope,action)=>[scope.kind,scope.target_id,action,...(scope.kind==='INTERACTION'?[]:[scope.body_hash,scope.media_hashes])];
