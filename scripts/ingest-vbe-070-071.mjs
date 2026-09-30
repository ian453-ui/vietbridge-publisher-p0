import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sources = {
  '070': { id: '1JkSgmaTho5k3hZ7fDsOItNOauC4hy0v9Hc-ckQaBHtM', imageIds: ['kix.zalt2a5p63lj', 'kix.iql1o4h57fte', 'kix.b1d0r9nevjmh', 'kix.pfr6jnjq6cx4', 'kix.4x54roizidu5'] },
  '071': { id: '1B6vLRkyaWDj7IF5zSRSnTE-p4229N0_vkL6_NNiJzQg', imageIds: ['kix.ssdr6hk37988', 'kix.6636kuiuubvn', 'kix.h0sjheofkwhj', 'kix.xm9gy59bkz40', 'kix.r4sbf1sio7yw'] },
};
const [inputDir, libraryRoot] = process.argv.slice(2);
if (!inputDir || !libraryRoot) throw new Error('usage: node ingest-vbe-070-071.mjs <docx-dir> <content-library-root>');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unzip = (path, entry) => execFileSync('unzip', ['-p', path, entry], { maxBuffer: 64 * 1024 * 1024 });
const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

for (const [number, source] of Object.entries(sources)) {
  const docx = resolve(inputDir, `${number}.docx`);
  const bytes = readFileSync(docx);
  const xml = unzip(docx, 'word/document.xml').toString('utf8');
  const rels = unzip(docx, 'word/_rels/document.xml.rels').toString('utf8');
  const mediaByRid = new Map();
  for (const match of rels.matchAll(/<Relationship\b([^>]+)\/?\s*>/g)) {
    const rid = match[1].match(/\bId="([^"]+)"/)?.[1];
    const target = match[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (rid && target?.startsWith('media/')) mediaByRid.set(rid, `word/${target}`);
  }
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(match => {
    const raw = match[0];
    return {
      text: [...raw.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(part => decode(part[1])).join('').trim(),
      image: [...raw.matchAll(/r:embed="([^"]+)"/g)].map(part => mediaByRid.get(part[1])).filter(Boolean)[0],
    };
  });
  const images = paragraphs.filter(p => p.image).map(p => p.image);
  if (images.length !== 5 || new Set(images).size !== 5) throw new Error(`${number}: expected five distinct inline images, got ${images.length}`);
  const articleId = `VBE-20260921-${number}`;
  const target = resolve(libraryRoot, 'Drive-Batches/VBE-20260921-070-071', articleId);
  mkdirSync(target, { recursive: true });
  const filenames = [
    `${articleId}_FRONTLOAD_HIGH_DENSITY_V02.png`,
    `${articleId}_COVER_V02.png`,
    `${articleId}_BODY_FACT_V02.png`,
    `${articleId}_BODY_FRAMEWORK_V02.png`,
    `${articleId}_BODY_ACTION_V02.png`,
  ];
  const sourceRevision = hash(bytes);
  const assetSources = {};
  images.forEach((media, index) => {
    const imageBytes = unzip(docx, media);
    writeFileSync(join(target, filenames[index]), imageBytes);
    assetSources[filenames[index]] = {
      role: index === 1 ? 'COVER' : 'BODY_INFOGRAPHIC',
      sequence: index === 1 ? 0 : index === 0 ? 1 : index,
      source_kind: 'DOCX_INLINE',
      source_doc_id: source.id,
      source_filename: `${number}.docx`,
      source_modified_revision: sourceRevision,
      inline_object_id: source.imageIds[index],
      sha256: hash(imageBytes),
    };
  });
  const title = paragraphs.find(p => p.text)?.text;
  if (!title || !(number === '070' ? title.includes('跨境结算') : title.includes('美国市场'))) throw new Error(`${number}: title mismatch`);
  let imageIndex = 0;
  const body = [];
  for (const paragraph of paragraphs) {
    if (paragraph.image) {
      if (imageIndex !== 1) body.push(`![${number}期知识图${imageIndex}](${filenames[imageIndex]})`);
      imageIndex++;
      continue;
    }
    const value = paragraph.text;
    if (!value || value === '〕') continue;
    if (value === title) { body.push(`# ${value}`); continue; }
    if (/^(?:[一二三四五六七八九十]+、|资料来源$|事实边界$)/u.test(value)) body.push(`## ${value}`);
    else body.push(value);
  }
  const publicFile = `${articleId}-wechat-public.md`;
  writeFileSync(join(target, publicFile), body.join('\n\n') + '\n');
  const manifest = {
    article_id: articleId,
    title,
    version: `public-final-v02-${sourceRevision.slice(0, 12)}`,
    content_type: 'image_text',
    source_doc_id: source.id,
    source_url: `https://docs.google.com/document/d/${source.id}`,
    source_revision: sourceRevision,
    canonical_source: 'public_final_v02',
    ingestion_contract: 'drive-docx-inline-v1',
    qa_status: 'PENDING_VISUAL_QA',
    publication_authorized: false,
    active_assets: [filenames[1], filenames[0], ...filenames.slice(2)],
    asset_sources: assetSources,
    platform_payloads: { wechat_official_account: publicFile },
  };
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ articleId, title, target, imageCount: images.length, sourceRevision, assetHashes: Object.fromEntries(Object.entries(assetSources).map(([k,v]) => [k,v.sha256])) }));
}
