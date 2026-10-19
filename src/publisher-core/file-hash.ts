import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';

// Bound peak memory even for multi-GB videos. Publication checks use fresh
// hashes; only library browsing reuses hashes for unchanged file identities.
export function hashFile(path: string): { sha256: string; sizeBytes: number; header: Buffer } {
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`asset is not a file: ${path}`);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
    let sizeBytes = 0, header = Buffer.alloc(0);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      if (!sizeBytes) header = Buffer.from(buffer.subarray(0, Math.min(count, 16)));
      hash.update(buffer.subarray(0, count));
      sizeBytes += count;
    }
    const after = fstatSync(fd);
    if (fileIdentity(before) !== fileIdentity(after) || sizeBytes !== after.size) throw new Error(`asset changed while hashing: ${path}`);
    return { sha256: hash.digest('hex'), sizeBytes, header };
  } finally { closeSync(fd); }
}

function fileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export class FileHashCache {
  private readonly entries = new Map<string, { identity: string; hash: string }>();
  private readonly maxEntries: number;
  constructor(maxEntries = 4096) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be positive');
    this.maxEntries = maxEntries;
  }

  get(path: string): string {
    const stat = statSync(path), identity = fileIdentity(stat);
    const cached = this.entries.get(path);
    if (cached?.identity === identity) {
      this.entries.delete(path); this.entries.set(path, cached);
      return cached.hash;
    }
    const result = hashFile(path);
    // Never associate a hash with metadata from an earlier revision.
    if (fileIdentity(statSync(path)) !== identity) throw new Error(`asset changed while hashing: ${path}`);
    this.entries.delete(path);
    this.entries.set(path, { identity, hash: result.sha256 });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return result.sha256;
  }
}
