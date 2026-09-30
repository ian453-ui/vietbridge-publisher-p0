import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.ts";
import { PublisherStore } from "../src/publisher-store.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "publisher-p0-"));
  const db = openDatabase(join(root, "publisher.sqlite"));
  const store = new PublisherStore(db);
  return { root, db, store, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function approvedJob(store: PublisherStore): string {
  const id = store.createJob({ articleId: "A-1", platform: "xiaohongshu", accountId: "acct-xhs", packageHash: "a".repeat(64), approvalRef: "approval-1" });
  store.transition(id, "FACT_CHECK");
  store.transition(id, "EDITORIAL_REVIEW");
  store.transition(id, "READY_FOR_USER_APPROVAL");
  store.transition(id, "USER_APPROVED");
  store.transition(id, "PLATFORM_PREFLIGHT");
  return id;
}

test("state transitions are atomic and illegal skips fail", () => {
  const f = fixture();
  try {
    const id = f.store.createJob({ articleId: "A-1", platform: "xhs", accountId: "acct", packageHash: "h" });
    assert.throws(() => f.store.transition(id, "PUBLISHED"), /Illegal transition/);
    assert.equal(f.store.getJob(id).state, "STORED_NOT_SCHEDULED");
    assert.equal(f.store.pendingOutbox().length, 0);
  } finally { f.close(); }
});

test("publication intent and form snapshot are committed before submit", () => {
  const f = fixture();
  try {
    const id = approvedJob(f.store);
    f.store.commitIntent(id, "publish_content", "b".repeat(64), ["c".repeat(64)], "approval-1");
    f.store.transition(id, "FORM_FILLING");
    f.store.saveFormSnapshot(id, { title: "越南政策", body: "正文", tags: ["越南"] });
    f.store.transition(id, "FORM_FILLED");
    assert.equal(f.store.getJob(id).state, "FORM_FILLED");
    assert.ok(f.store.latestFormSnapshot(id));
    assert.ok(f.store.pendingOutbox().length >= 6);
  } finally { f.close(); }
});

test("same profile cannot be held by two jobs", () => {
  const f = fixture();
  try {
    const one = f.store.createJob({ articleId: "A-1", platform: "xhs", accountId: "acct", packageHash: "1" });
    const two = f.store.createJob({ articleId: "A-2", platform: "xhs", accountId: "acct", packageHash: "2" });
    assert.equal(f.store.acquireProfile("profile-acct", one), true);
    assert.equal(f.store.acquireProfile("profile-acct", two), false);
    f.store.releaseProfile("profile-acct", one);
    assert.equal(f.store.acquireProfile("profile-acct", two), true);
  } finally { f.close(); }
});

test('retry reuses unchanged intent before submit and rejects changed content', () => {
  const f=fixture();
  try {
    const id=approvedJob(f.store);
    const intent=f.store.commitIntent(id,'publish_content','b',['c'],'approval-1');
    f.store.db.prepare("UPDATE jobs SET state='PLATFORM_PREFLIGHT' WHERE job_id=?").run(id);
    assert.throws(()=>f.store.commitIntent(id,'publish_content','changed',['c'],'approval-1'),/differs/);
    assert.equal(f.store.commitIntent(id,'publish_content','b',['c'],'approval-1'),intent);
    f.store.db.prepare("UPDATE jobs SET state='PLATFORM_PREFLIGHT',submit_safety_domain='MAY_HAVE_SUBMITTED' WHERE job_id=?").run(id);
    assert.throws(()=>f.store.commitIntent(id,'publish_content','b',['c'],'approval-1'),/reconciliation/);
  } finally { f.close(); }
});

test('retry accepts a new approval ID only when scope and frozen content are identical',()=>{
  const f=fixture();
  try{
    const id=approvedJob(f.store);
    const add=(approvalId:string,scope:string,payload:string,time:string)=>f.db.prepare('INSERT INTO approval_records(approval_id,approval_scope_hash,platform,account_id,visibility,payload_hash,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?)').run(approvalId,scope,'xiaohongshu','acct-xhs','public',payload,'user',time);
    add('approval-1','same-scope','b','2026-09-23T00:00:00Z');
    add('approval-2','same-scope','b','2026-09-23T00:01:00Z');
    add('approval-other','different-scope','b','2026-09-23T00:02:00Z');
    const intent=f.store.commitIntent(id,'publish_content','b',['c'],'approval-1');
    f.db.prepare("UPDATE jobs SET state='PLATFORM_PREFLIGHT' WHERE job_id=?").run(id);
    assert.equal(f.store.commitIntent(id,'publish_content','b',['c'],'approval-2'),intent);
    f.db.prepare("UPDATE jobs SET state='PLATFORM_PREFLIGHT' WHERE job_id=?").run(id);
    assert.throws(()=>f.store.commitIntent(id,'publish_content','b',['c'],'approval-other'),/differs/);
    assert.throws(()=>f.store.commitIntent(id,'publish_content','b',['changed'],'approval-2'),/differs/);
  }finally{f.close();}
});

test("startup recovery converts unconfirmed submits to reconcile pending without resubmit", () => {
  const f = fixture();
  try {
    const id = approvedJob(f.store);
    f.store.commitIntent(id, "publish_content", "b", [], "approval-1");
    f.store.transition(id, "SUBMITTED_PENDING_CONFIRMATION");
    const recovered = f.store.recoverSubmittedJobs();
    assert.deepEqual(recovered, [id]);
    assert.equal(f.store.getJob(id).state, "RECONCILE_PENDING");
    const transitions = f.db.prepare("SELECT to_state FROM state_transitions WHERE job_id=? ORDER BY transition_id").all(id) as {to_state:string}[];
    assert.equal(transitions.filter(x => x.to_state === "SUBMITTED_PENDING_CONFIRMATION").length, 1);
  } finally { f.close(); }
});

test("cloud mirror failure preserves pending event and platform state", () => {
  const f = fixture();
  try {
    const id = f.store.createJob({ articleId: "A-1", platform: "facebook", accountId: "page", packageHash: "h" });
    f.store.transition(id, "FACT_CHECK");
    const event = f.store.pendingOutbox()[0];
    f.store.markMirrorFailed(String(event.event_id), "drive unavailable", new Date(Date.now() + 1000).toISOString());
    assert.equal(f.store.getJob(id).state, "FACT_CHECK");
    const pending = f.store.pendingOutbox();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].attempt_count, 1);
    assert.equal(pending[0].mirrored_at, null);
  } finally { f.close(); }
});
