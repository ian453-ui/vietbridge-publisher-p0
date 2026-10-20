import type { Db } from "./database.ts";
import { transaction } from "./database.ts";
import { canonicalJson, newId, now, sha256 } from "./util.ts";

export class ExecutionModel {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  createAttempt(jobId: string, authorizationReason: string, workerId?: string): Record<string, unknown> {
    return transaction(this.db, () => {
      const job = this.requireJob(jobId);
      if (["PUBLISHED", "PUBLISHED_ID_PENDING", "RECONCILE_PENDING"].includes(String(job.state))) throw new Error(`attempt forbidden from ${job.state}`);
      if (job.submit_safety_domain === "MAY_HAVE_SUBMITTED") throw new Error("attempt forbidden while prior submit may have occurred");
      const latest = this.db.prepare("SELECT COALESCE(MAX(attempt_number),0) AS n, COALESCE(MAX(fencing_token),0) AS f FROM platform_attempts WHERE job_id=?").get(jobId) as { n: number; f: number };
      const attemptId = newId();
      this.db.prepare(`INSERT INTO platform_attempts
        (attempt_id,job_id,attempt_number,authorization_reason,worker_id,fencing_token,safe_phase,started_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(attemptId, jobId, latest.n + 1, authorizationReason, workerId ?? null, latest.f + 1, "BEFORE_EXTERNAL_SUBMIT", now());
      this.db.prepare("UPDATE jobs SET current_attempt_id=? WHERE job_id=?").run(attemptId, jobId);
      this.appendEventUnsafe(jobId, attemptId, "ATTEMPT_STARTED", { authorizationReason, fencingToken: latest.f + 1 });
      return this.getAttempt(attemptId);
    });
  }

  markSubmitStarted(jobId: string, attemptId: string): void {
    transaction(this.db, () => {
      this.assertCurrentAttempt(jobId, attemptId);
      this.db.prepare("UPDATE platform_attempts SET safe_phase='MAY_HAVE_SUBMITTED',submit_started_at=? WHERE attempt_id=?").run(now(), attemptId);
      this.db.prepare("UPDATE jobs SET submit_safety_domain='MAY_HAVE_SUBMITTED',submitted_at=? WHERE job_id=?").run(now(), jobId);
      this.appendEventUnsafe(jobId, attemptId, "SUBMIT_STARTED", {});
    });
  }

  recordReceipt(jobId: string, attemptId: string | null, input: { type: string; platformPostId?: string; platformUrl?: string; rawStatus?: string; evidence: unknown }): string {
    return transaction(this.db, () => {
      if (attemptId) this.assertCurrentAttempt(jobId, attemptId);
      else this.requireJob(jobId);
      const receiptId = newId();
      this.db.prepare(`INSERT INTO platform_receipts
        (receipt_id,job_id,attempt_id,receipt_type,platform_post_id,platform_url,raw_status,evidence_json,observed_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(receiptId, jobId, attemptId, input.type, input.platformPostId ?? null, input.platformUrl ?? null,
          input.rawStatus ?? null, canonicalJson(input.evidence), now());
      this.appendEventUnsafe(jobId, attemptId, "RECEIPT_RECORDED", { receiptId, type: input.type });
      return receiptId;
    });
  }

  openAttention(batchId: string, input: { jobId?: string; attemptId?: string; kind: string; messageCode: string; detail?: unknown }): string {
    return transaction(this.db, () => {
      const id = newId();
      this.db.prepare(`INSERT INTO attention_requests
        (attention_id,batch_id,job_id,attempt_id,kind,message_code,detail_json,status,created_at)
        VALUES(?,?,?,?,?,?,?,'OPEN',?)`).run(id, batchId, input.jobId ?? null, input.attemptId ?? null, input.kind,
          input.messageCode, canonicalJson(input.detail ?? {}), now());
      if (input.jobId) this.appendEventUnsafe(input.jobId, input.attemptId ?? null, "ATTENTION_REQUIRED", { attentionId: id, kind: input.kind });
      return id;
    });
  }

  getAttempt(id: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM platform_attempts WHERE attempt_id=?").get(id);
    if (!row) throw new Error(`Unknown attempt: ${id}`);
    return row as Record<string, unknown>;
  }

  private requireJob(jobId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId);
    if (!row) throw new Error(`Unknown job: ${jobId}`);
    return row as Record<string, unknown>;
  }
  private assertCurrentAttempt(jobId: string, attemptId: string): void {
    const job = this.requireJob(jobId);
    if (job.current_attempt_id !== attemptId) throw new Error("stale fencing token/attempt");
  }
  private appendEventUnsafe(jobId: string, attemptId: string | null, eventType: string, payload: unknown): void {
    const eventId = newId(); const json = canonicalJson(payload); const time = now();
    this.db.prepare("INSERT INTO job_events(event_id,job_id,attempt_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(eventId, jobId, attemptId, eventType, json, time);
    this.db.prepare(`INSERT INTO outbox_events(event_id,job_id,event_type,payload_json,payload_hash,created_at)
      VALUES(?,?,?,?,?,?)`).run(eventId, jobId, eventType, json, sha256(json), time);
  }
}
