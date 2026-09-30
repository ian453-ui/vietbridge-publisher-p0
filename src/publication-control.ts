import type { Db } from "./database.ts";
import { transaction } from "./database.ts";
import { canonicalJson, newId, now } from "./util.ts";
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from "./platform-contract.ts";

export const SOURCE_MODES = ["ledger", "local_path", "url", "search"] as const;
export type SourceMode = typeof SOURCE_MODES[number];
export const CONTROL_STATES = ["DRAFT", "QUEUED", "RUNNING", "PAUSE_REQUESTED", "PAUSED", "COMPLETED"] as const;
export type ControlState = typeof CONTROL_STATES[number];

export type NewPublicationBatch = {
  title?: string;
  sourceMode: SourceMode;
  sourceValue?: string;
  platforms?: SupportedPlatform[];
  defaultAllPlatforms?: boolean;
};

export class PublicationControl {
  private readonly db: Db;

  constructor(db: Db) { this.db = db; }

  create(input: NewPublicationBatch): string {
    if (!SOURCE_MODES.includes(input.sourceMode)) throw new Error("invalid source mode");
    if (input.sourceMode !== "ledger" && !input.sourceValue?.trim()) throw new Error("source value required");
    const defaultAll = input.defaultAllPlatforms !== false;
    const platforms = normalizePlatforms(defaultAll ? [...SUPPORTED_PLATFORMS] : (input.platforms ?? []));
    if (!platforms.length) throw new Error("at least one platform required");
    const id = newId(); const time = now();
    const title = input.title?.trim() || automaticTitle(input.sourceMode, input.sourceValue, new Date(time));
    transaction(this.db, () => this.db.prepare(`INSERT INTO publication_batches
      (batch_id,title,source_mode,source_value,platforms_json,default_all_platforms,control_state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'DRAFT',?,?)`).run(id, title, input.sourceMode, input.sourceValue?.trim() || null,
        canonicalJson(platforms), defaultAll ? 1 : 0, time, time));
    return id;
  }

  list(): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM publication_batches ORDER BY updated_at DESC").all().map(row => decode(row as Record<string, unknown>));
  }

  get(id: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM publication_batches WHERE batch_id=?").get(id);
    if (!row) throw new Error(`Unknown batch: ${id}`);
    return decode(row as Record<string, unknown>);
  }

  command(id: string, command: "queue" | "start" | "pause" | "resume"): Record<string, unknown> {
    return transaction(this.db, () => {
      const current = this.get(id); const state = current.control_state as ControlState;
      const next = nextState(state, command); const pause = next === "PAUSE_REQUESTED" || next === "PAUSED";
      this.db.prepare("UPDATE publication_batches SET control_state=?,pause_requested=?,updated_at=? WHERE batch_id=?")
        .run(next, pause ? 1 : 0, now(), id);
      return this.get(id);
    });
  }
}

export function automaticTitle(sourceMode: SourceMode, sourceValue: string | undefined, date: Date): string {
  const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
  const raw = sourceValue?.trim();
  let hint = "默认台账内容";
  if (raw) {
    if (sourceMode === "local_path") hint = raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
    else if (sourceMode === "url") {
      try { hint = decodeURIComponent(new URL(raw).pathname.split("/").filter(Boolean).pop() ?? new URL(raw).hostname); }
      catch { hint = raw; }
    } else hint = raw;
  }
  hint = hint.replace(/\s+/g, " ").slice(0, 48);
  return `${stamp} ${hint}`;
}

function two(value: number): string { return String(value).padStart(2, "0"); }

function normalizePlatforms(input: SupportedPlatform[]): SupportedPlatform[] {
  return [...new Set(input)].filter(x => SUPPORTED_PLATFORMS.includes(x));
}
function decode(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, platforms: JSON.parse(String(row.platforms_json)), default_all_platforms: Boolean(row.default_all_platforms), pause_requested: Boolean(row.pause_requested) };
}
function nextState(state: ControlState, command: "queue" | "start" | "pause" | "resume"): ControlState {
  if (command === "queue" && state === "DRAFT") return "QUEUED";
  if (command === "start" && state === "QUEUED") return "RUNNING";
  if (command === "pause" && state === "RUNNING") return "PAUSE_REQUESTED";
  if (command === "resume" && (state === "PAUSED" || state === "PAUSE_REQUESTED")) return "RUNNING";
  throw new Error(`illegal control command ${command} from ${state}`);
}
