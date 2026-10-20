#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { openDatabase } from "./database.ts";
import { PublisherStore } from "./publisher-store.ts";
import { verifyPackage, type PackageManifest } from "./package-integrity.ts";
import type { JobState } from "./states.ts";
import { applySubmitEvidence, type SubmitEvidence } from "./runtime-policy.ts";
import { XiaohongshuMcpConnector } from "./xiaohongshu-mcp-connector.ts";
import { XiaohongshuDriver, type XiaohongshuPayload } from "./xiaohongshu-driver.ts";
import { inspectResourceHealth } from "./resource-monitor.ts";
import { syncOutboxToJsonl } from "./jsonl-mirror.ts";
import { planMultiplatform, type MultiplatformInput } from "./multiplatform-planner.ts";
import { FacebookMcpConnector } from "./facebook-mcp-connector.ts";

const [command, ...args] = process.argv.slice(2);
const dbPath = process.env.PUBLISHER_DB ?? resolve("data/publisher.sqlite");
const db = openDatabase(dbPath);
const store = new PublisherStore(db);

function json(value: unknown) { console.log(JSON.stringify(value, null, 2)); }

try {
  switch (command) {
    case "init": json({ ok: true, dbPath }); break;
    case "create-job": {
      const [articleId, platform, accountId, packageHash, approvalRef] = args;
      if (!articleId || !platform || !accountId || !packageHash) throw new Error("create-job articleId platform accountId packageHash [approvalRef]");
      json({ jobId: store.createJob({ articleId, platform, accountId, packageHash, approvalRef }) });
      break;
    }
    case "status": json(store.getJob(required(args[0], "jobId"))); break;
    case "transition": {
      store.transition(required(args[0], "jobId"), required(args[1], "state") as JobState, args[2] ? JSON.parse(args[2]) : {});
      json(store.getJob(args[0])); break;
    }
    case "recover": json({ reconcilePending: store.recoverSubmittedJobs() }); break;
    case "commit-intent": {
      const [jobId, operation, payloadHash, approvalRef, mediaHashesJson = "[]"] = args;
      json({ intentId: store.commitIntent(required(jobId, "jobId"), required(operation, "operation"), required(payloadHash, "payloadHash"), JSON.parse(mediaHashesJson), required(approvalRef, "approvalRef")) });
      break;
    }
    case "save-form": {
      const [jobId, fieldsJson] = args;
      json({ snapshotId: store.saveFormSnapshot(required(jobId, "jobId"), JSON.parse(required(fieldsJson, "fieldsJson"))) });
      break;
    }
    case "record-submit-result": {
      const [jobId, evidenceJson] = args;
      json({ state: applySubmitEvidence(store, required(jobId, "jobId"), JSON.parse(required(evidenceJson, "evidenceJson")) as SubmitEvidence) });
      break;
    }
    case "record-platform-result": {
      store.recordPlatformResult(required(args[0], "jobId"), required(args[1], "platformId"), required(args[2], "platformUrl"));
      json(store.getJob(args[0]));
      break;
    }
    case "outbox": json(store.pendingOutbox()); break;
    case "health": json({ dbPath, resources: inspectResourceHealth(db, dbPath) }); break;
    case "sync-outbox": json(syncOutboxToJsonl(store, required(args[0], "mirrorPath"))); break;
    case "verify-package": {
      const root = required(args[0], "packageRoot");
      const manifestPath = required(args[1], "manifestPath");
      json(verifyPackage(root, JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest));
      break;
    }
    case "xhs-probe": {
      const connector = new XiaohongshuMcpConnector(process.env.XHS_MCP_URL);
      try {
        json({ tools: await connector.availableReadTools(), login: await connector.loginStatus() });
      } finally { await connector.close(); }
      break;
    }
    case "xhs-readback": {
      const [accountId, fingerprint, title, returnedId, xsecToken] = args;
      const connector = new XiaohongshuMcpConnector(process.env.XHS_MCP_URL);
      try {
        json(await connector.findPublished({ accountId: required(accountId, "accountId"), payloadFingerprint: required(fingerprint, "fingerprint"), title: required(title, "title"), returnedId, xsecToken }));
      } finally { await connector.close(); }
      break;
    }
    case "xhs-dry-run": {
      const payloadPath = required(args[0], "payloadPath");
      const connector = new XiaohongshuMcpConnector(process.env.XHS_MCP_URL);
      const driver = new XiaohongshuDriver(connector);
      try {
        json(driver.dryRun(JSON.parse(readFileSync(payloadPath, "utf8")) as XiaohongshuPayload));
      } finally { await connector.close(); }
      break;
    }
    case "xhs-publish-video": {
      const payloadPath = required(args[0], "payloadPath");
      if (args[1] !== "CONFIRM_SINGLE_LIVE_SUBMIT") throw new Error("Exact live confirmation token required");
      const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as {
        title: string; content: string; video: string; tags: string[]; visibility: string; products: unknown[];
      };
      const connector = new XiaohongshuMcpConnector(process.env.XHS_MCP_URL);
      try { json(await connector.publishVideo(payload)); }
      finally { await connector.close(); }
      break;
    }
    case "plan-multiplatform": {
      const packagePath = required(args[0], "packagePath");
      const contextPath = args[1];
      const input = JSON.parse(readFileSync(packagePath, "utf8")) as MultiplatformInput;
      const contexts = contextPath ? JSON.parse(readFileSync(contextPath, "utf8")) : {};
      json(planMultiplatform(input, contexts));
      break;
    }
    case "fb-auth": {
      const connector = new FacebookMcpConnector();
      try { json(await connector.call("fb_get_auth_status")); }
      finally { await connector.close(); }
      break;
    }
    case "fb-reel": {
      const payloadPath = required(args[0], "payloadPath");
      const live = args[1] === "CONFIRM_SINGLE_LIVE_SUBMIT";
      const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
      const connector = new FacebookMcpConnector();
      try { json(await connector.call("fb_publish_reel", { ...payload, dry_run: !live })); }
      finally { await connector.close(); }
      break;
    }
    case "fb-video-status": {
      const connector = new FacebookMcpConnector();
      try { json(await connector.call("fb_get_video_status", { video_id: required(args[0], "videoId") })); }
      finally { await connector.close(); }
      break;
    }
    default:
      console.log("Commands: init | create-job | status | transition | commit-intent | save-form | record-submit-result | record-platform-result | recover | outbox | health | sync-outbox | verify-package | plan-multiplatform | fb-auth | fb-reel | fb-video-status | xhs-probe | xhs-readback | xhs-dry-run | xhs-publish-video");
      process.exitCode = command ? 2 : 0;
  }
} finally {
  db.close();
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
