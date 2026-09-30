import test from "node:test";
import assert from "node:assert/strict";
import { classifySubmitEvidence, preflightOutcome } from "../src/runtime-policy.ts";

test("transport success without platform readback reconciles", () => {
  assert.deepEqual(classifySubmitEvidence({ kind: "live_post", returnedId: "123", readback: "absent" }), ["UNKNOWN", "RECONCILE_PENDING"]);
});

test("ambiguous transport failures never become failed or published", () => {
  for (const error of ["timeout", "tcp_reset", "connection_lost"] as const) {
    assert.deepEqual(classifySubmitEvidence({ kind: "live_post", error, readback: "unavailable" }), ["UNKNOWN", "RECONCILE_PENDING"]);
  }
});

test("WeChat draft is not called published", () => {
  assert.deepEqual(classifySubmitEvidence({ kind: "wechat_draft", returnedId: "media-1", readback: "match" }), ["DRAFT_API_WRITTEN_NOT_PUBLISHED"]);
});

test("empty ID with authoritative success becomes pending ID without retry", () => {
  assert.deepEqual(classifySubmitEvidence({ kind: "live_post", successRedirect: true, readback: "unavailable" }), ["PUBLISHED_ID_PENDING"]);
});

test("live post requires returned ID and matching independent readback", () => {
  assert.deepEqual(classifySubmitEvidence({ kind: "live_post", returnedId: "post-1", returnedUrl: "https://example.test/post-1", readback: "match" }), ["PUBLISHED"]);
});

test("preflight blocks resource pressure and browser readiness failures", () => {
  const baseline = { profileLockHeld: true, sessionHealthy: true, devtoolsReady: true, editorReady: true, packageIntegrity: true, outboxCritical: false, freeDiskCritical: false };
  assert.equal(preflightOutcome(baseline), "PASS");
  assert.equal(preflightOutcome({ ...baseline, outboxCritical: true }), "FAILED_PREFLIGHT");
  assert.equal(preflightOutcome({ ...baseline, devtoolsReady: false }), "FAILED_PREFLIGHT");
  assert.equal(preflightOutcome({ ...baseline, profileLockHeld: false }), "PROFILE_LOCKED");
  assert.equal(preflightOutcome({ ...baseline, sessionHealthy: false }), "SESSION_EXPIRED");
});
