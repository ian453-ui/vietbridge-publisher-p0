import type { Db } from "./database.ts";
import { transaction } from "./database.ts";
import { canTransition, type JobState } from "./states.ts";
import { canonicalJson, newId, now, sha256 } from "./util.ts";

export type NewJob = {
  jobId?: string; articleId: string; platform: string; accountId: string;
  packageHash: string; approvalRef?: string;
};

export class PublisherStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  createJob(input: NewJob): string {
    const jobId = input.jobId ?? newId();
    const time = now();
    transaction(this.db, () => this.db.prepare(`INSERT INTO jobs
      (job_id,article_id,platform,account_id,package_hash,state,created_at,updated_at,approval_ref)
      VALUES (?,?,?,?,?,'STORED_NOT_SCHEDULED',?,?,?)`)
      .run(jobId, input.articleId, input.platform, input.accountId, input.packageHash, time, time, input.approvalRef ?? null));
    return jobId;
  }

  getJob(jobId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId);
    if (!row) throw new Error(`Unknown job: ${jobId}`);
    return row as Record<string, unknown>;
  }

  listJobs(limit = 200): Record<string, unknown>[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return this.db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC, created_at DESC LIMIT ?").all(safeLimit) as Record<string, unknown>[];
  }

  jobHistory(jobId: string): Record<string, unknown>[] {
    this.getJob(jobId);
    return this.db.prepare("SELECT * FROM state_transitions WHERE job_id=? ORDER BY transition_id").all(jobId) as Record<string, unknown>[];
  }

  recordPlatformResult(jobId: string, platformId: string, platformUrl: string): void {
    transaction(this.db, () => {
      this.getJob(jobId);
      this.db.prepare("UPDATE jobs SET platform_id=?,platform_url=?,updated_at=? WHERE job_id=?")
        .run(platformId, platformUrl, now(), jobId);
    });
  }

  transition(jobId: string, to: JobState, evidence: unknown = {}): void {
    transaction(this.db, () => {
      const job = this.getJob(jobId);
      const from = job.state as JobState;
      if (!canTransition(from, to)) throw new Error(`Illegal transition ${from} -> ${to}`);
      const time = now();
      const eventId = newId();
      this.db.prepare("UPDATE jobs SET state=?,updated_at=? WHERE job_id=? AND state=?").run(to, time, jobId, from);
      this.db.prepare(`INSERT INTO state_transitions(job_id,from_state,to_state,event_id,evidence_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(jobId, from, to, eventId, canonicalJson(evidence), time);
      this.enqueueUnsafe(eventId, jobId, "STATE_TRANSITION", { from, to, evidence, time });
    });
  }

  commitIntent(jobId: string, operation: string, payloadHash: string, mediaHashes: string[], approvalRef: string): string {
    return transaction(this.db, () => {
      const job = this.getJob(jobId);
      if (job.state !== "PLATFORM_PREFLIGHT") throw new Error("Intent requires PLATFORM_PREFLIGHT");
      const previous = this.db.prepare('SELECT * FROM publication_intents WHERE job_id=?').get(jobId) as Record<string,unknown> | undefined;
      if (previous) {
        if (job.submit_safety_domain === 'MAY_HAVE_SUBMITTED') throw new Error('Previous attempt may have submitted; reconciliation required');
        const sameApproval=previous.approval_ref===approvalRef||this.equivalentApproval(String(previous.approval_ref),approvalRef);
        if (previous.operation !== operation || previous.payload_hash !== payloadHash || !sameApproval || previous.media_hashes_json !== canonicalJson(mediaHashes)) throw new Error('Retry intent differs from approved content');
        this.transitionUnsafe(jobId, 'PUBLICATION_INTENT_COMMITTED', {intentId:previous.intent_id, reusedBeforeSubmit:true,approvalRef,priorApprovalRef:previous.approval_ref});
        return String(previous.intent_id);
      }
      const intentId = newId();
      this.db.prepare(`INSERT INTO publication_intents
        (intent_id,job_id,operation,payload_hash,media_hashes_json,approval_ref,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(intentId, jobId, operation, payloadHash, canonicalJson(mediaHashes), approvalRef, now());
      this.transitionUnsafe(jobId, "PUBLICATION_INTENT_COMMITTED", { intentId, operation, payloadHash, mediaHashes });
      return intentId;
    });
  }

  private equivalentApproval(firstId:string,secondId:string):boolean{
    const query='SELECT approval_scope_hash,platform,account_id,visibility,payload_hash,expires_at,revoked_at FROM approval_records WHERE approval_id=?';
    const first=this.db.prepare(query).get(firstId) as Record<string,unknown>|undefined;
    const second=this.db.prepare(query).get(secondId) as Record<string,unknown>|undefined;
    return Boolean(first&&second&&!second.revoked_at&&(!second.expires_at||String(second.expires_at)>now())&&first.approval_scope_hash===second.approval_scope_hash&&first.platform===second.platform&&first.account_id===second.account_id&&first.visibility===second.visibility&&first.payload_hash===second.payload_hash);
  }

  saveFormSnapshot(jobId: string, fields: Record<string, unknown>, retainedUntil?: string): string {
    const json = canonicalJson(fields);
    const id = newId();
    transaction(this.db, () => this.db.prepare(`INSERT INTO form_snapshots
      (snapshot_id,job_id,fields_json,fields_hash,created_at,retained_until) VALUES(?,?,?,?,?,?)`)
      .run(id, jobId, json, sha256(json), now(), retainedUntil ?? null));
    return id;
  }

  latestFormSnapshot(jobId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM form_snapshots WHERE job_id=? ORDER BY created_at DESC LIMIT 1").get(jobId);
    return row ? row as Record<string, unknown> : null;
  }

  acquireProfile(profileId: string, jobId: string): boolean {
    return transaction(this.db, () => {
      try {
        const time = now();
        this.db.prepare("INSERT INTO profile_locks(profile_id,job_id,acquired_at,heartbeat_at) VALUES(?,?,?,?)").run(profileId, jobId, time, time);
        return true;
      } catch (error) {
        if (String(error).includes("UNIQUE constraint")) return false;
        throw error;
      }
    });
  }

  heartbeatProfile(profileId: string, jobId: string): void {
    const result = this.db.prepare("UPDATE profile_locks SET heartbeat_at=? WHERE profile_id=? AND job_id=?").run(now(), profileId, jobId);
    if (result.changes !== 1) throw new Error("Profile lock not held by job");
  }

  releaseProfile(profileId: string, jobId: string): void {
    transaction(this.db, () => this.db.prepare("DELETE FROM profile_locks WHERE profile_id=? AND job_id=?").run(profileId, jobId));
  }

  recordProfileHealth(profileId: string, accountId: string, input: {
    status: string; chromeVersion?: string; profileSizeBytes?: number;
    devtoolsReady: boolean; editorReady: boolean; detail?: unknown;
  }): void {
    transaction(this.db, () => this.db.prepare(`INSERT INTO profile_health
      (profile_id,account_id,checked_at,status,chrome_version,profile_size_bytes,devtools_ready,editor_ready,detail_json)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET
      account_id=excluded.account_id,checked_at=excluded.checked_at,status=excluded.status,
      chrome_version=excluded.chrome_version,profile_size_bytes=excluded.profile_size_bytes,
      devtools_ready=excluded.devtools_ready,editor_ready=excluded.editor_ready,detail_json=excluded.detail_json`)
      .run(profileId, accountId, now(), input.status, input.chromeVersion ?? null, input.profileSizeBytes ?? null,
        input.devtoolsReady ? 1 : 0, input.editorReady ? 1 : 0, canonicalJson(input.detail ?? {})));
  }

  pendingOutbox(): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM outbox_events WHERE mirrored_at IS NULL ORDER BY created_at").all() as Record<string, unknown>[];
  }

  markMirrored(eventId: string): void {
    transaction(this.db, () => this.db.prepare("UPDATE outbox_events SET mirrored_at=?,last_error=NULL WHERE event_id=?").run(now(), eventId));
  }

  markMirrorFailed(eventId: string, error: string, nextRetryAt: string): void {
    transaction(this.db, () => this.db.prepare(`UPDATE outbox_events SET attempt_count=attempt_count+1,last_error=?,next_retry_at=?
      WHERE event_id=? AND mirrored_at IS NULL`).run(error, nextRetryAt, eventId));
  }

  recoverSubmittedJobs(): string[] {
    const rows = this.db.prepare(`SELECT job_id,state FROM jobs WHERE state IN ('SUBMITTED_PENDING_CONFIRMATION','UNKNOWN')`).all() as {job_id:string,state:JobState}[];
    for (const row of rows) {
      if (row.state === "SUBMITTED_PENDING_CONFIRMATION") this.transition(row.job_id, "UNKNOWN", { reason: "startup_recovery_after_unconfirmed_submit" });
      this.transition(row.job_id, "RECONCILE_PENDING", { reason: "startup_recovery_requires_platform_readback" });
    }
    return rows.map(r => r.job_id);
  }

  private transitionUnsafe(jobId: string, to: JobState, evidence: unknown): void {
    const job = this.getJob(jobId);
    const from = job.state as JobState;
    if (!canTransition(from, to)) throw new Error(`Illegal transition ${from} -> ${to}`);
    const time = now();
    const eventId = newId();
    this.db.prepare("UPDATE jobs SET state=?,updated_at=? WHERE job_id=? AND state=?").run(to, time, jobId, from);
    this.db.prepare(`INSERT INTO state_transitions(job_id,from_state,to_state,event_id,evidence_json,created_at)
      VALUES(?,?,?,?,?,?)`).run(jobId, from, to, eventId, canonicalJson(evidence), time);
    this.enqueueUnsafe(eventId, jobId, "STATE_TRANSITION", { from, to, evidence, time });
  }

  private enqueueUnsafe(eventId: string, jobId: string, eventType: string, payload: unknown): void {
    const json = canonicalJson(payload);
    this.db.prepare(`INSERT INTO outbox_events(event_id,job_id,event_type,payload_json,payload_hash,created_at)
      VALUES(?,?,?,?,?,?)`).run(eventId, jobId, eventType, json, sha256(json), now());
  }
}
