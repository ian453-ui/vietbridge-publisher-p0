import type { PublisherStore } from "./publisher-store.ts";
import type { JobState } from "./states.ts";

export type SubmitEvidence = {
  kind: "live_post" | "wechat_draft";
  returnedId?: string;
  returnedUrl?: string;
  successRedirect?: boolean;
  authoritativeConnectorSuccess?: boolean;
  readback: "match" | "absent" | "mismatch" | "unavailable";
  error?: "timeout" | "tcp_reset" | "connection_lost" | "explicit_rejection";
};

export type PreflightSignals = {
  profileLockHeld: boolean;
  sessionHealthy: boolean;
  devtoolsReady: boolean;
  editorReady: boolean;
  packageIntegrity: boolean;
  outboxCritical: boolean;
  freeDiskCritical: boolean;
};

export function preflightOutcome(signals: PreflightSignals): JobState | "PASS" {
  if (!signals.profileLockHeld) return "PROFILE_LOCKED";
  if (!signals.sessionHealthy) return "SESSION_EXPIRED";
  if (!signals.devtoolsReady || !signals.editorReady || !signals.packageIntegrity || signals.outboxCritical || signals.freeDiskCritical) return "FAILED_PREFLIGHT";
  return "PASS";
}

export function classifySubmitEvidence(evidence: SubmitEvidence): JobState[] {
  if (evidence.error === "explicit_rejection" && !evidence.successRedirect && !evidence.returnedId) return ["FAILED"];
  if (evidence.error && evidence.error !== "explicit_rejection") return ["UNKNOWN", "RECONCILE_PENDING"];
  if (evidence.readback === "match" && evidence.kind === "wechat_draft" && evidence.returnedId) return ["DRAFT_API_WRITTEN_NOT_PUBLISHED"];
  if (evidence.readback === "match" && evidence.kind === "live_post" && evidence.returnedId) return ["PUBLISHED"];
  if (!evidence.returnedId && evidence.readback === "unavailable" && (evidence.successRedirect || evidence.authoritativeConnectorSuccess)) return ["PUBLISHED_ID_PENDING"];
  return ["UNKNOWN", "RECONCILE_PENDING"];
}

export function applySubmitEvidence(store: PublisherStore, jobId: string, evidence: SubmitEvidence): JobState {
  const sequence = classifySubmitEvidence(evidence);
  for (const state of sequence) store.transition(jobId, state, { submitEvidence: evidence });
  return sequence.at(-1)!;
}
