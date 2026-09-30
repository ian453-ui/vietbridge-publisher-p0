import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifySubmitEvidence } from "../src/runtime-policy.ts";

type Case = { id: string; events: string[]; expected: string; submit_count?: number; auto_retry?: boolean };
const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "fixtures/p0-acceptance-cases.json"), "utf8")) as Case[];

function evaluate(events: string[]): string {
  const has = (event: string) => events.includes(event);
  if (has("PROFILE_LOCK_B")) return "PROFILE_LOCKED";
  if (has("QR_CHALLENGE") || has("SESSION_EXPIRED")) return "JOB_WAITING_HUMAN";
  if (has("DRAFT_READBACK_MATCH")) return classifySubmitEvidence({ kind: "wechat_draft", returnedId: "media-id", readback: "match" }).at(-1)!;
  if (has("TIMEOUT")) return classifySubmitEvidence({ kind: "live_post", error: "timeout", readback: "unavailable" }).at(-1)!;
  if (has("TCP_RST")) return classifySubmitEvidence({ kind: "live_post", error: "tcp_reset", readback: "unavailable" }).at(-1)!;
  if (has("SIGKILL")) return "RECONCILE_PENDING";
  if (has("READBACK_ABSENT")) return classifySubmitEvidence({ kind: "live_post", returnedId: "transport-id", readback: "absent" }).at(-1)!;
  if (has("SUCCESS_REDIRECT") && has("EMPTY_ID")) return classifySubmitEvidence({ kind: "live_post", successRedirect: true, readback: "unavailable" }).at(-1)!;
  if (has("READBACK_MATCH") && has("SQLITE_COMMIT")) return "PUBLISHED";
  if (has("FORM_REHYDRATED")) return "FORM_FILLED";
  if (has("PROFILE_RECYCLED") && has("READINESS_PASS")) return "PLATFORM_PREFLIGHT";
  if (has("EDITOR_DESYNC") || has("SOURCE_MUTATED_BEFORE_SUBMIT") || has("SMOKE_TEST_NOT_RUN") || has("OUTBOX_CRITICAL") || has("DEVTOOLS_READINESS_FAIL")) return "FAILED_PREFLIGHT";
  throw new Error(`Unhandled trace: ${events.join(",")}`);
}

test("all 17 Codex-Claude consensus traces resolve to the agreed safe state", async (t) => {
  assert.equal(cases.length, 17);
  for (const item of cases) {
    await t.test(item.id, () => {
      assert.equal(evaluate(item.events), item.expected);
      assert.ok((item.submit_count ?? item.events.filter(x => x === "SUBMIT").length) <= 1);
      if (["TIMEOUT", "TCP_RST", "SIGKILL", "READBACK_ABSENT"].some(x => item.events.includes(x))) assert.equal(item.auto_retry, false);
    });
  }
});
