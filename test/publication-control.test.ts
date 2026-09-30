import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.ts";
import { PublicationControl } from "../src/publication-control.ts";
import { TaskService } from "../src/task-service.ts";
import { PublisherStore } from "../src/publisher-store.ts";
import { PlatformWorker } from "../src/platform-worker.ts";

test("default ledger task targets all four platforms and supports safe control commands", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-control-")); const db = openDatabase(join(root, "db.sqlite"));
  try {
    const control = new PublicationControl(db); const id = control.create({ title: "Daily-018", sourceMode: "ledger" });
    assert.deepEqual(control.get(id).platforms, ["xiaohongshu", "facebook", "wechat_channels", "wechat_official_account"]);
    assert.equal(control.command(id, "queue").control_state, "QUEUED");
    assert.equal(control.command(id, "start").control_state, "RUNNING");
    assert.equal(control.command(id, "pause").control_state, "PAUSE_REQUESTED");
    assert.equal(control.command(id, "resume").control_state, "RUNNING");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("manual source requires a value and at least one selected platform", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-control-")); const db = openDatabase(join(root, "db.sqlite"));
  try {
    const control = new PublicationControl(db);
    assert.throws(() => control.create({ title: "x", sourceMode: "local_path", defaultAllPlatforms: false, platforms: ["facebook"] }), /source value required/);
    assert.throws(() => control.create({ title: "x", sourceMode: "ledger", defaultAllPlatforms: false, platforms: [] }), /at least one platform/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("task title is automatically generated from local time and content hint", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-control-")); const db = openDatabase(join(root, "db.sqlite"));
  try {
    const control = new PublicationControl(db);
    const id = control.create({ sourceMode: "local_path", sourceValue: "/content/Daily-018-video.mp4", platforms: ["facebook"], defaultAllPlatforms: false });
    assert.match(String(control.get(id).title), /^\d{8}-\d{4} Daily-018-video\.mp4$/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("approval advances only ready platforms and never resubmits a sibling awaiting reconciliation",()=>{
  const root=mkdtempSync(join(tmpdir(),"publisher-partial-approval-")),db=openDatabase(join(root,"db.sqlite"));
  try{
    const batchId='batch-mixed',time=new Date().toISOString();
    db.prepare(`INSERT INTO publication_batches(batch_id,title,source_mode,platforms_json,default_all_platforms,control_state,pause_requested,created_at,updated_at) VALUES(?,?,?, ?,0,'AWAITING_APPROVAL',0,?,?)`)
      .run(batchId,'mixed','article_id','["xiaohongshu","facebook"]',time,time);
    const store=new PublisherStore(db);
    const xhs=store.createJob({articleId:'A-1',platform:'xiaohongshu',accountId:'xhs',packageHash:'a'.repeat(64)});
    const facebook=store.createJob({articleId:'A-1',platform:'facebook',accountId:'fb',packageHash:'b'.repeat(64)});
    db.prepare(`UPDATE jobs SET batch_id=?,state='RECONCILE_PENDING',submit_safety_domain='MAY_HAVE_SUBMITTED',payload_hash=? WHERE job_id=?`).run(batchId,'x'.repeat(64),xhs);
    db.prepare(`UPDATE jobs SET batch_id=?,state='READY_FOR_USER_APPROVAL',payload_hash=? WHERE job_id=?`).run(batchId,'f'.repeat(64),facebook);
    const tasks=new TaskService(db,{roots:[],stagingRoot:join(root,'staging')});
    tasks.approve(batchId);
    assert.equal(store.getJob(xhs).state,'RECONCILE_PENDING');
    assert.equal(store.getJob(xhs).submit_safety_domain,'MAY_HAVE_SUBMITTED');
    assert.equal(store.getJob(facebook).state,'PLATFORM_PREFLIGHT');
    db.prepare("UPDATE publication_batches SET control_state='PAUSED' WHERE batch_id=?").run(batchId);
    tasks.pauseOrTerminate(batchId);
    assert.equal(tasks.getBatch(batchId).control_state,'TERMINATED');
    assert.equal(store.getJob(xhs).state,'RECONCILE_PENDING');
    assert.equal(store.getJob(xhs).submit_safety_domain,'MAY_HAVE_SUBMITTED');
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test("background worker never opens Xiaohongshu for a terminated reconciliation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"publisher-xhs-background-")),db=openDatabase(join(root,"db.sqlite"));
  try{
    const batchId='batch-terminated',time=new Date(Date.now()-60*60_000).toISOString();
    db.prepare(`INSERT INTO publication_batches(batch_id,title,source_mode,platforms_json,default_all_platforms,control_state,pause_requested,created_at,updated_at) VALUES(?,?,?, ?,0,'TERMINATED',1,?,?)`)
      .run(batchId,'terminated','article_id','["xiaohongshu"]',time,time);
    const store=new PublisherStore(db),jobId=store.createJob({articleId:'A-2',platform:'xiaohongshu',accountId:'xhs',packageHash:'c'.repeat(64)});
    db.prepare(`UPDATE jobs SET batch_id=?,state='RECONCILE_PENDING',submit_safety_domain='MAY_HAVE_SUBMITTED',updated_at=? WHERE job_id=?`).run(batchId,time,jobId);
    const worker=new PlatformWorker(db);let calls=0;
    (worker as unknown as {reconcileXiaohongshu:(id:string)=>Promise<unknown>}).reconcileXiaohongshu=async()=>{calls++;return {};};
    await worker.tick();
    assert.equal(calls,0);
    assert.equal(store.getJob(jobId).state,'RECONCILE_PENDING');
    await worker.stop();
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
