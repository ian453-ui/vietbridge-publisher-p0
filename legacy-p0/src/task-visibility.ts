// Display only: never infer a completed failure from an uncertain submission.
export function completedFailure(batch: { control_state: string }, job: { state: string; submit_safety_domain?: string }): boolean {
  return batch.control_state === 'COMPLETED' && job.submit_safety_domain !== 'MAY_HAVE_SUBMITTED' &&
    ['FAILED', 'FAILED_PREFLIGHT', 'BLOCKED_CAPABILITY'].includes(job.state);
}

