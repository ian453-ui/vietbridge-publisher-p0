// Display only: never infer a completed failure from an uncertain submission.
export function completedFailure(batch: { control_state: string }, job: { state: string; submit_safety_domain?: string }): boolean {
  return batch.control_state === 'COMPLETED' && job.submit_safety_domain !== 'MAY_HAVE_SUBMITTED' &&
    ['FAILED', 'FAILED_PREFLIGHT', 'BLOCKED_CAPABILITY'].includes(job.state);
}

// Hiding is reversible, but must never conceal work or an unresolved submission.
export function canHideHistory(batch: { control_state: string }, job: { state: string; submit_safety_domain?: string }): boolean {
  if (job.submit_safety_domain === 'MAY_HAVE_SUBMITTED') return false;
  if (['PUBLISHED', 'DRAFT_API_WRITTEN_NOT_PUBLISHED'].includes(job.state)) return true;
  if (completedFailure(batch, job)) return true;
  return batch.control_state === 'TERMINATED' &&
    ['FAILED', 'FAILED_PREFLIGHT', 'BLOCKED_CAPABILITY', 'PLATFORM_DELETED'].includes(job.state);
}
