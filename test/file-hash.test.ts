import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { hashFile, FileHashCache } from '../src/file-hash.ts';

test('chunked hashing matches whole-file SHA and keeps only the MIME header', () => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-hash-'));
  try {
    const path = join(root, 'large.mp4'), bytes = Buffer.alloc(1024 * 1024 + 17, 37);
    writeFileSync(path, bytes);
    const result = hashFile(path);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.sizeBytes, bytes.length);
    assert.deepEqual(result.header, bytes.subarray(0, 16));
    writeFileSync(path, '');
    assert.equal(hashFile(path).sha256, createHash('sha256').digest('hex'));
    assert.equal(hashFile(path).header.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unchanged media is not reread; replacement with restored mtime rotates revision', t => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-hash-cache-'));
  const original = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => { reads++; return Reflect.apply(original, fs, args); });
  syncBuiltinESMExports();
  try {
    const path = join(root, 'asset.png'); writeFileSync(path, 'old');
    const cache = new FileHashCache(), first = cache.get(path), count = reads;
    assert.equal(cache.get(path), first); assert.equal(reads, count);
    const stat = statSync(path); writeFileSync(path, 'new'); utimesSync(path, stat.atime, stat.mtime);
    assert.notEqual(cache.get(path), first); assert.ok(reads > count);
    const bounded = new FileHashCache(1), other = join(root, 'other.png'); writeFileSync(other, 'other');
    bounded.get(path); bounded.get(other); const before = reads; bounded.get(path);
    assert.ok(reads > before, 'evicted hashes must be recomputed');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
