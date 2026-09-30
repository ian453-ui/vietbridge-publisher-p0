import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { Db } from "./database.ts";
import { transaction } from "./database.ts";
import { canonicalJson, newId, now, sha256 } from "./util.ts";

export type SnapshotAssetInput = {
  assetId?: string;
  contentId?: string;
  filename?: string;
  sourcePath?: string;
  sourceDriveId?: string;
  sourceFolderId?: string;
  qaState?: string;
  sequence?: number;
  role: "cover" | "gallery_image" | "article_inline" | "video" | "video_cover" | "attachment";
  ordinal: number;
  path: string;
  sourceRevision?: string;
};

export type SnapshotInput = {
  articleId: string;
  contentVersion: string;
  canonicalPayload: Record<string, unknown>;
  sourceKind: string;
  sourceLocator?: string;
  sourceRevision?: string;
  assets: SnapshotAssetInput[];
};

export class ContentSnapshotStore {
  constructor(privateDb: Db, privateStagingRoot: string) {
    this.db = privateDb;
    this.stagingRoot = resolve(privateStagingRoot);
  }
  private readonly db: Db;
  private readonly stagingRoot: string;

  create(input: SnapshotInput): Record<string, unknown> {
    if (!input.articleId.trim() || !input.contentVersion.trim()) throw new Error("articleId and contentVersion required");
    if (!input.assets.length) throw new Error("at least one asset required");
    const inspected = input.assets.map(asset => inspectAsset(asset));
    const manifest = {
      articleId: input.articleId,
      contentVersion: input.contentVersion,
      canonicalPayload: input.canonicalPayload,
      assets: inspected.map(({ role, ordinal, sha256: hash, mimeDetected, sizeBytes }) => ({ role, ordinal, sha256: hash, mimeDetected, sizeBytes }))
    };
    const manifestHash = sha256(canonicalJson(manifest));
    const existing = this.db.prepare("SELECT * FROM content_snapshots WHERE article_id=? AND content_version=? AND manifest_hash=?")
      .get(input.articleId, input.contentVersion, manifestHash) as Record<string, unknown> | undefined;
    if (existing) return this.get(String(existing.snapshot_id));

    const snapshotId = newId();
    const snapshotRoot = join(this.stagingRoot, manifestHash);
    mkdirSync(snapshotRoot, { recursive: true });
    const staged = inspected.map(asset => {
      const safeName = `${String(asset.ordinal).padStart(3, "0")}-${asset.role}-${basename(asset.path)}`;
      const stagingPath = join(snapshotRoot, safeName);
      if (!existsSync(stagingPath)) copyFileSync(asset.path, stagingPath);
      if (sha256(readFileSync(stagingPath)) !== asset.sha256) throw new Error(`staging hash mismatch: ${safeName}`);
      return { ...asset, stagingPath };
    });

    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO content_snapshots
        (snapshot_id,article_id,content_version,manifest_hash,canonical_payload_json,source_kind,source_locator,source_revision,staging_root,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(snapshotId, input.articleId, input.contentVersion, manifestHash,
          canonicalJson(input.canonicalPayload), input.sourceKind, input.sourceLocator ?? null, input.sourceRevision ?? null, snapshotRoot, now());
      const insert = this.db.prepare(`INSERT INTO content_assets
        (asset_id,snapshot_id,role,ordinal,original_locator,staging_path,sha256,mime_detected,size_bytes,source_revision,source_asset_id,content_id,filename,qa_state,source_drive_id,source_folder_id,source_path,sequence)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const asset of staged) insert.run(newId(), snapshotId, asset.role, asset.ordinal, asset.path, asset.stagingPath,
        asset.sha256, asset.mimeDetected, asset.sizeBytes, asset.sourceRevision ?? null,asset.assetId??null,asset.contentId??input.articleId,asset.filename??basename(asset.path),asset.qaState??'UNKNOWN',asset.sourceDriveId??null,asset.sourceFolderId??null,asset.sourcePath??asset.path,asset.sequence??asset.ordinal);
    });
    return this.get(snapshotId);
  }

  get(snapshotId: string): Record<string, unknown> {
    const snapshot = this.db.prepare("SELECT * FROM content_snapshots WHERE snapshot_id=?").get(snapshotId) as Record<string, unknown> | undefined;
    if (!snapshot) throw new Error(`Unknown snapshot: ${snapshotId}`);
    const assets = this.db.prepare("SELECT * FROM content_assets WHERE snapshot_id=? ORDER BY role,ordinal").all(snapshotId);
    return { ...snapshot, canonicalPayload: JSON.parse(String(snapshot.canonical_payload_json)), assets };
  }
}

function inspectAsset(input: SnapshotAssetInput) {
  const path = resolve(input.path);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`asset is not a file: ${path}`);
  const data = readFileSync(path);
  return { ...input, path, sha256: sha256(data), mimeDetected: detectMime(data, extname(path)), sizeBytes: data.length };
}

function detectMime(data: Buffer, extension: string): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if ([".md", ".txt", ".json"].includes(extension.toLowerCase())) return "text/plain";
  return "application/octet-stream";
}
