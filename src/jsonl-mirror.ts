import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { PublisherStore } from "./publisher-store.ts";

export type MirrorResult = { mirrored: number; skipped: number; failed: number };

export function syncOutboxToJsonl(store: PublisherStore, path: string): MirrorResult {
  mkdirSync(dirname(path), { recursive: true });
  const known = loadEventIds(path);
  let mirrored = 0, skipped = 0, failed = 0;
  const fd = openSync(path, "a", 0o600);
  try {
    for (const event of store.pendingOutbox()) {
      const eventId = String(event.event_id);
      if (known.has(eventId)) {
        store.markMirrored(eventId);
        skipped++;
        continue;
      }
      try {
        const line = JSON.stringify({
          event_id: eventId,
          job_id: event.job_id,
          event_type: event.event_type,
          payload_hash: event.payload_hash,
          payload: JSON.parse(String(event.payload_json)),
          created_at: event.created_at
        }) + "\n";
        writeSync(fd, line, undefined, "utf8");
        fsyncSync(fd);
        known.add(eventId);
        store.markMirrored(eventId);
        mirrored++;
      } catch (error) {
        failed++;
        store.markMirrorFailed(eventId, String(error), new Date(Date.now() + 30_000).toISOString());
        break;
      }
    }
  } finally { closeSync(fd); }
  return { mirrored, skipped, failed };
}

function loadEventIds(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { event_id?: unknown };
      if (typeof value.event_id === "string") ids.add(value.event_id);
    } catch {
      throw new Error(`Invalid JSONL mirror; refusing append: ${path}`);
    }
  }
  return ids;
}
