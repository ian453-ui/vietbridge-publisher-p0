import { createHash, randomUUID } from "node:crypto";

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();
export const canonicalJson = (value: unknown) => JSON.stringify(sort(value));
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]));
  }
  return value;
}

