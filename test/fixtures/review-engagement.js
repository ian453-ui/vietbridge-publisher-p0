/** Explicit manual approval in synthetic tests, never used by application code. */
export function reviewFixtureCandidate(store,workspace,candidate){const view=store.engagementCandidateView(workspace,candidate.id);return store.saveEngagementDraft(workspace,candidate.id,{account_id:candidate.account_id,scope_hash:view.scope_hash,body:'先记录邀约、面试和到岗各环节，再核对流失环节。',reviewed:true});}
