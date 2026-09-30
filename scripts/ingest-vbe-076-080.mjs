import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [sourceText, assetDir, libraryRoot] = process.argv.slice(2);
if (!sourceText || !assetDir || !libraryRoot) throw new Error('usage: node ingest-vbe-076-080.mjs <batch.txt> <assets-dir> <library-root>');
const text = readFileSync(sourceText, 'utf8');
const sourceDocId = '1KwJBf8kfI2UVRFT5MxmxRPFKCw5ugrAHwji6Hu4Lijo';
const folderId = '1KhK4njZdTrusjk05xcer7ZWHI7Mkyglu';
const driveIds = {
  '076': ['1BbltXnOMxMSeLr5moWV0FVkZoDuYt8h2','1XD7rfa5FqjunkfF5jS-eSVWMvolmK-af','11E8UKZcBN1xrKIKlRaiBC_3-c8YWQwUj','19rwOSUnIvul2NPHkGZywmQQFvViGyeNi'],
  '077': ['1G43Ml9Rb3LNfUtjzgwrTH2okASOS595e','1Hyqk6pQNgRvonsFkdIjnyzsp5h3-MuME','1CxhlJywu6YnkjWxr39n88vKGBEepaA2-','1fgiNA65nxXADkWnVu0Ef93ZW8QFKXbD1'],
  '078': ['1G5IM-ICWKQlP4fYGU19aPRLpFcw6zIka','1FhIHJQ3HCaBY-JIKd1uT4jS56_Ioo1Gt','1FRst_EgmnCf3WlWmlau4wdVHATbFjvLz','1pAbmZ3Y7B_Lqy3jqU0H2QSSzG49in5Rj'],
  '079': ['121F5p71XpzRhKJy0SPYeTQs7QB_T8cOg','1BHYQUMkTuivk2Yy6z0ry-MjvV7Uk6mNL','1nfaNuAP6x-BHsHnwIzFSlI0z3qK5q1KV','1vJNS7cwx_3AXh9vtmQS7MMgOdWKLCdBl'],
  '080': ['1LljDob6UiNLiVk0NjIReWaqShq5IVbJE','11JaZ8UjPH8WvKQCq2gGOPujSMa_oSE1r','1Dmqpbuqs6HxQ2kjLmN0FcdmoSOQMR5r0','19SVwBbqZ1oJ_sJYxF8-XNyMEfdiQPV09'],
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const batchRevision = sha256(readFileSync(sourceText));
for (const [number, ids] of Object.entries(driveIds)) {
  const articleId = `VBE-20260925-${number}`;
  const start = text.indexOf(`content_id: ${articleId}`);
  const next = text.indexOf('content_id: VBE-', start + 12);
  const block = text.slice(start, next < 0 ? undefined : next);
  const title = block.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const match = block.match(/【公开母稿｜微信公众号】([\s\S]*?)【公开母稿结束｜微信公众号】/u);
  if (start < 0 || !title || !match || !block.includes('status: CONTENT_VISUAL_QA_PASS')) throw new Error(`${articleId}: source content incomplete`);
  const lines = match[1].split(/\r?\n/u).map(s => s.trim()).filter(Boolean);
  if (lines[0] !== title) throw new Error(`${articleId}: title mismatch`);
  const filenames = ['COVER','BODY_FACT','BODY_FRAMEWORK','BODY_ACTION'].map(role => `${articleId}_${role}_V01.png`);
  const target = resolve(libraryRoot, 'Drive-Batches/VBE-20260925-076-080', articleId);
  mkdirSync(target, { recursive: true });
  const assetSources = {};
  filenames.forEach((filename, index) => {
    const source = join(assetDir, filename);
    const bytes = readFileSync(source);
    copyFileSync(source, join(target, filename));
    assetSources[filename] = { role: index ? 'BODY_INFOGRAPHIC' : 'COVER', sequence: index, source_kind: 'DRIVE_ACTIVE_ASSET', drive_file_id: ids[index], source_doc_id: sourceDocId, source_folder_id: folderId, sha256: sha256(bytes) };
  });
  const body = [`---`, `title: "${title.replaceAll('"','\\"')}"`, 'author: 驻越经营实录', `cover: ${filenames[0]}`, `---`, '', `# ${title}`];
  let factInserted = false, frameworkInserted = false, actionInserted = false;
  let leadLength = 0;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^【|^content_id:|^status:|^ASSET_/u.test(line)) throw new Error(`${articleId}: internal marker in public body`);
    if (!frameworkInserted && /^四、/u.test(line)) {
      body.push(`![${number}期经营框架](${filenames[2]})`, `图02｜${number}期经营框架。`);
      frameworkInserted = true;
    }
    if (!actionInserted && /^结语$/u.test(line)) {
      body.push(`![${number}期企业行动图](${filenames[3]})`, `图03｜${number}期企业行动要点。`);
      actionInserted = true;
    }
    body.push(/^(?:[一二三四五六七八九十]+、|结语$)/u.test(line) ? `## ${line}` : line);
    if (!factInserted && !/^#/u.test(line)) {
      leadLength += line.length;
      if (leadLength >= 80 && leadLength <= 180) {
        body.push(`![${number}期事实总览](${filenames[1]})`, `图01｜${number}期关键事实。`);
        factInserted = true;
      }
    }
  }
  if (!factInserted || !frameworkInserted || !actionInserted) throw new Error(`${articleId}: image placement incomplete`);
  const publicFile = `${articleId}-wechat-public.md`;
  writeFileSync(join(target, publicFile), body.join('\n\n') + '\n');
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({
    article_id: articleId, title, version: `visual-batch-${batchRevision.slice(0,12)}`, content_type: 'image_text',
    source_doc_id: sourceDocId, source_folder_id: folderId, source_url: `https://docs.google.com/document/d/${sourceDocId}`,
    source_revision: batchRevision, canonical_source: 'public_batch_doc', ingestion_contract: 'drive-platform-payload-v1',
    qa_status: 'PENDING_VISUAL_QA', blocking_issue: 'NEED_FRONTLOAD_GENERATION: BODY_FACT is a single-topic fact card, not an independently readable high-density article overview.',
    publication_authorized: false, active_assets: filenames, asset_sources: assetSources,
    platform_payloads: { wechat_official_account: publicFile }
  }, null, 2) + '\n');
  console.log(JSON.stringify({ articleId, title, target, sourceRevision: batchRevision, imageCount: filenames.length }));
}
