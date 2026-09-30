import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./util.ts";

export type PackageManifest = {
  articleId: string;
  revision: string;
  files: { path: string; sha256: string; bytes: number }[];
};

export function verifyPackage(root: string, manifest: PackageManifest): { ok: boolean; packageHash: string; errors: string[] } {
  const errors: string[] = [];
  for (const file of manifest.files) {
    const absolute = resolve(root, file.path);
    try {
      const data = readFileSync(absolute);
      if (data.length !== file.bytes) errors.push(`${file.path}: byte count changed`);
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== file.sha256) errors.push(`${file.path}: sha256 changed`);
    } catch (error) {
      errors.push(`${file.path}: ${String(error)}`);
    }
  }
  const packageHash = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
  return { ok: errors.length === 0, packageHash, errors };
}

export function assertFrozenDirectory(root: string): void {
  const mode = statSync(root).mode & 0o222;
  if (mode !== 0) throw new Error(`PublishPackage directory is writable: ${root}`);
}
