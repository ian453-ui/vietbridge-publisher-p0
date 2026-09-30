import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "./database.ts";

export type ResourceLimits = {
  maxPendingOutboxEvents: number;
  maxDatabaseBytes: number;
  minFreeDiskBytes: number;
  warningRatio: number;
};

export type ResourceHealth = {
  pendingOutboxEvents: number;
  databaseBytes: number;
  freeDiskBytes: number;
  warning: boolean;
  critical: boolean;
  reasons: string[];
};

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxPendingOutboxEvents: 10_000,
  maxDatabaseBytes: 512 * 1024 * 1024,
  minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
  warningRatio: 0.8
};

export function inspectResourceHealth(db: Db, databasePath: string, limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS): ResourceHealth {
  const pending = Number((db.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE mirrored_at IS NULL").get() as { count: number }).count);
  const databaseBytes = statSync(databasePath).size;
  const fs = statfsSync(dirname(databasePath));
  const freeDiskBytes = Number(fs.bavail) * Number(fs.bsize);
  const reasons: string[] = [];
  const critical = pending >= limits.maxPendingOutboxEvents || databaseBytes >= limits.maxDatabaseBytes || freeDiskBytes <= limits.minFreeDiskBytes;
  if (pending >= limits.maxPendingOutboxEvents) reasons.push("pending_outbox_limit");
  if (databaseBytes >= limits.maxDatabaseBytes) reasons.push("database_size_limit");
  if (freeDiskBytes <= limits.minFreeDiskBytes) reasons.push("free_disk_limit");
  const warning = critical || pending >= limits.maxPendingOutboxEvents * limits.warningRatio || databaseBytes >= limits.maxDatabaseBytes * limits.warningRatio;
  return { pendingOutboxEvents: pending, databaseBytes, freeDiskBytes, warning, critical, reasons };
}
