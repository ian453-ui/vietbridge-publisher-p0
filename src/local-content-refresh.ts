import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ingestDocxContentBundle } from './docx-content-ingestor.ts';

type Manifest = Record<string, unknown> & { article_id?: string; source_doc_id?: string; source_revision?: string; asset_sources?: Record<string, Record<string, unknown>>; active_assets?: string[] };
const documentId = (value: unknown) => String(value ?? '').split('#')[0].trim();
const fingerprint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const validId = (id: string) => /^[A-Za-z0-9_-]{15,}$/.test(id);

/** Consumes files already present on this Mac; no Google API or background polling. */
export class LocalContentRefresher {
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  /** Import a locally exported DOCX without changing any frozen publication task. */
  refreshDocx(articleId: string, bytes: Buffer) {
    if (!/^VBE-\d{8}-\d{3}$/.test(articleId)) throw new Error('INVALID_CONTENT_ID');
    if (bytes.length < 4 || !bytes.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('DOCX_FILE_REQUIRED');
    const rows = findManifests(this.root).map(path => ({ path, data: readManifest(path) }))
      .filter(row => row.data?.canonical_source === 'independent_rewrite_doc');
    const selected = rows.find(row => row.data?.article_id === articleId);
    if (!selected) throw new Error('CANONICAL_DOCUMENT_PACKAGE_NOT_FOUND');
    const sourceId = documentId(selected.data!.source_doc_id);
    if (!validId(sourceId)) throw new Error('CANONICAL_DRIVE_DOCUMENT_ID_MISSING');
    const siblings = rows.filter(row => documentId(row.data!.source_doc_id) === sourceId);
    const allowedIds = new Set(siblings.map(row => String(row.data!.article_id)));
    const temporary = mkdtempSync(join(tmpdir(), 'vietbridge-doc-refresh-'));
    const docxPath = join(temporary, 'source.docx');
    writeFileSync(docxPath, bytes);
    try {
      const overrides = Object.fromEntries(siblings.map(row => [String(row.data!.article_id), activeOverrides(row.data!)]));
      // Parse and materialize in isolation before touching the live library.
      const preview = ingestDocxContentBundle(docxPath, join(temporary, 'preview'), { driveFileId: sourceId, activeAssetOverrides: overrides });
      const incoming = new Set(preview.imported.map(item => item.articleId));
      if (!incoming.has(articleId) || [...incoming].some(id => !allowedIds.has(id))) throw new Error('DOCX_ARTICLE_ID_MISMATCH');
      const targetRoot = dirname(dirname(selected.path));
      const updated = ingestDocxContentBundle(docxPath, targetRoot, {
        driveFileId: sourceId,
        driveFolderId: String(selected.data!.source_folder_id ?? ''),
        sourceUrl: String(selected.data!.source_url ?? ''),
        activeAssetOverrides: overrides
      });
      for (const item of updated.imported) {
        const path = join(item.target, 'manifest.json');
        const manifest = readManifest(path);
        if (!manifest) throw new Error('IMPORTED_MANIFEST_MISSING');
        manifest.manual_refreshed_at = new Date().toISOString();
        writeManifest(path, manifest);
      }
      return { sourceRevision: updated.sourceRevision, imported: updated.imported.map(item => ({ articleId: item.articleId, assetCount: item.assetCount })), publicationTasksChanged: false };
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  refreshImage(articleId: string, filename: string, bytes: Buffer, qaConfirmed: boolean) {
    if (!/^VBE-\d{8}-\d{3}$/.test(articleId)) throw new Error('INVALID_CONTENT_ID');
    if (!qaConfirmed) throw new Error('IMAGE_QA_CONFIRMATION_REQUIRED');
    if (!/^[^/\\]+\.(?:png|jpe?g|webp)$/i.test(filename) || filename.startsWith('.')) throw new Error('INVALID_IMAGE_FILENAME');
    if (!validImage(bytes,filename)) throw new Error('IMAGE_FORMAT_MISMATCH');
    const row = findManifests(this.root).map(path => ({ path, data: readManifest(path) }))
      .find(row => row.data?.article_id === articleId && row.data?.canonical_source === 'independent_rewrite_doc' && row.data.active_assets?.includes(filename));
    if (!row?.data) throw new Error('ACTIVE_IMAGE_NOT_FOUND');
    const path = join(dirname(row.path),filename);
    const oldHash=existsSync(path)?fingerprint(readFileSync(path)):'';
    const newHash=fingerprint(bytes);
    if(oldHash!==newHash){const temporary=`${path}.refresh-${process.pid}`;writeFileSync(temporary,bytes);renameSync(temporary,path);}
    const current=readManifest(row.path);
    if(!current)throw new Error('CANONICAL_MANIFEST_MISSING');
    const previous=current.asset_sources?.[filename]??{};
    const updated:Record<string,unknown>={...previous,sha256:newHash,manual_qa_confirmed_at:new Date().toISOString(),source_manual_revision:newHash};
    current.asset_sources={...current.asset_sources,[filename]:updated};
    writeManifest(row.path,current);
    return {articleId,filename,changed:oldHash!==newHash,revision:newHash,publicationTasksChanged:false};
  }
}

function activeOverrides(manifest: Manifest) {
  return (manifest.active_assets ?? []).filter(name => /\.(png|jpe?g|webp)$/i.test(name)).map(name => {
    const source = manifest.asset_sources?.[name] ?? {};
    return { filename: name, role: /cover/i.test(String(source.role ?? name)) ? 'cover' as const : 'body' as const,
      driveFileId: String(source.drive_file_id ?? '') || undefined, inlineObjectId: String(source.inline_object_id ?? '') || undefined,
      semanticLabel: String(source.semantic_label ?? '') || undefined };
  });
}
function readManifest(path: string): Manifest | undefined { try { return JSON.parse(readFileSync(path, 'utf8')) as Manifest; } catch { return undefined; } }
function writeManifest(path: string, value: Manifest) { const temporary = `${path}.refresh-${process.pid}`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, path); }
function findManifests(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (dir: string, depth: number) => { if (depth > 8) return; for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) visit(path, depth + 1); else if (entry.name === 'manifest.json') result.push(path);
  }};
  visit(root, 0); return result;
}
function validImage(bytes:Buffer,filename:string):boolean{
  const lower=filename.toLowerCase();
  if(lower.endsWith('.png'))return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(/\.jpe?g$/.test(lower))return bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  return lower.endsWith('.webp')&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
}
