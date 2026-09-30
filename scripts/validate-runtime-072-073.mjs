import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContentLibrary } from '../src/content-library.ts';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const libraryRoot = resolve(project, '../Content-Library');
const batchRoot = join(libraryRoot, 'Drive-Batches/VBE-20260923-072-073');
const ledgerPath = resolve(project, '../Shared-Publication-State/shared-publication-ledger.yaml');
const api = 'http://127.0.0.1:17880';
const idList = ['VBE-20260923-072', 'VBE-20260923-073'];
const expected = {
  'VBE-20260923-072': [
    ['VBE-20260923-072_COVER_V01.png', 'cover', '1hq5foHB1oWUIfpO7grSsv9Fvs7QHFwn-'],
    ['VBE-20260923-072_BODY_FACT_V01.png', 'gallery_image', '1Yi0MNkAl_P0GFHmciDeuXWiRbmim3dCR'],
    ['VBE-20260923-072_BODY_FRAMEWORK_V01.png', 'gallery_image', '1cE9BsBUYGPC__5r0m_NR-nczWED6vbgH'],
    ['VBE-20260923-072_BODY_ACTION_V01.png', 'gallery_image', '13LJ1HYpjWTRfa745HujeHTW5waFeQB7D'],
  ],
  'VBE-20260923-073': [
    ['VBE-20260923-073_COVER_V01.png', 'cover', '128LWx0hdMrgsOl9QqRNXRNlcxwt-RiLz'],
    ['VBE-20260923-073_BODY_FACT_V01.png', 'gallery_image', '1VdAZbutVaZjw9PzLYqx5tjsAUnLmxUaT'],
    ['VBE-20260923-073_BODY_FRAMEWORK_V01.png', 'gallery_image', '18A_Ha9CeCmEmbEoXfNx7ut5YblyU8E9-'],
    ['VBE-20260923-073_BODY_ACTION_V01.png', 'gallery_image', '1MGtBVKJwgfZh-SzRQ1hcwtOSlq1KlBSO'],
  ],
};
const platforms = ['wechat_official_account', 'facebook', 'linkedin', 'xiaohongshu'];
const internal = /(?:\bDRAFT\b|FACT_QA|INTERNAL QA|EDITORIAL_REVIEW|READY_FOR_USER_APPROVAL|USER_APPROVED|blocking_issues|article_id\s*:|owner\s*:|修改记录|审核意见|返修单|内部备注|Facebook版本|LinkedIn版本|小红书版本)/iu;
const library = new ContentLibrary({ roots: [libraryRoot], ledgerPath });
const assertions = [];
const failures = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (name, ok, detail = '') => { assertions.push({ name, status: ok ? 'PASS' : 'FAIL', detail }); if (!ok) failures.push(name); };

const candidatesResponse = await fetch(`${api}/api/content/candidates?includeIncomplete=1&includePublished=1`);
if (!candidatesResponse.ok) throw new Error(`candidate API HTTP ${candidatesResponse.status}`);
const candidatesData = await candidatesResponse.json();
const candidateItems = candidatesData.candidates.filter(x => idList.includes(x.articleId));
for (const id of idList) {
  const local = library.index().filter(x => x.articleId === id);
  const remote = candidateItems.filter(x => x.articleId === id);
  check(`${id}: exactly one indexed ContentItem`, local.length === 1, `count=${local.length}`);
  check(`${id}: exactly one Publisher candidate`, remote.length === 1, `count=${remote.length}`);
  const item = local[0];
  const candidate = remote[0];
  if (!item || !candidate) continue;
  check(`${id}: runtime READY`, item.readiness === 'READY' && candidate.readiness === 'READY', `local=${item.readiness}; api=${candidate.readiness}; blockers=${item.blockingReasons.join('|')}`);
  check(`${id}: no duplicate candidate`, item.duplicateCandidates === 0 && candidate.duplicateCandidates === 0, `local=${item.duplicateCandidates}; api=${candidate.duplicateCandidates}`);
  const manifestPath = join(batchRoot, id, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expectedAssets = expected[id];
  check(`${id}: canonical doc binding`, manifest.source_doc_id === '1YG1dhjmB5GNrJnQEdMJ24yNZdsp5I-vsYzPlwzQm9H4' && item.canonicalDocument.driveFileId === manifest.source_doc_id, `doc=${manifest.source_doc_id}`);
  check(`${id}: publication remains unauthorized`, manifest.publication_authorized === false, `authorized=${manifest.publication_authorized}`);
  check(`${id}: active_assets exact`, JSON.stringify(manifest.active_assets) === JSON.stringify(expectedAssets.map(x => x[0])), `active=${manifest.active_assets.join('|')}`);
  check(`${id}: no stale extra media`, readdirSync(join(batchRoot, id)).filter(name => /\.(?:png|jpe?g|webp|mp4)$/iu.test(name)).length === 4, 'expected exactly 4 active image files');
  check(`${id}: asset role/order/source binding`, item.assets.length === 4 && item.assets.every((asset, index) => asset.filename === expectedAssets[index][0] && asset.role === expectedAssets[index][1] && asset.sourceDriveId === expectedAssets[index][2] && asset.sourceDocId === manifest.source_doc_id), JSON.stringify(item.assets.map(x => [x.filename, x.role, x.sequence, x.sourceDriveId])));
  for (const platform of platforms) check(`${id}: ${platform} payload available`, Boolean(item.payloads[platform]), item.payloads[platform] ?? 'missing');
  const payloadText = Object.fromEntries(platforms.map(platform => [platform, readFileSync(item.payloads[platform], 'utf8')]));
  for (const [platform, text] of Object.entries(payloadText)) check(`${id}: ${platform} public-copy isolation`, !internal.test(text), 'internal marker scan');

  const expectedNames = expectedAssets.map(x => x[0]);
  const wechatText = payloadText.wechat_official_account;
  const imageNames = [...wechatText.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^)]+))\)/gu)].map(match => basename(match[1] ?? match[2]));
  check(`${id}: WeChat inline image sequence`, JSON.stringify(imageNames) === JSON.stringify(expectedNames), imageNames.join(' → '));
  for (const name of expectedNames) {
    const imageAt = wechatText.indexOf(`](${name})`);
    const before = wechatText.slice(0, imageAt);
    const after = wechatText.slice(imageAt + name.length + 3);
    const caption = after.match(/^\s*\n(图\s*\d+\s*｜[^\n]+)/u)?.[1] ?? '';
    check(`${id}: WeChat inline image caption ${name}`, imageAt >= 0 && Boolean(caption), caption || 'caption not immediately after image');
    check(`${id}: WeChat explanatory text before ${name}`, before.trim().length > 30, 'image has preceding public text');
  }
  const previewResponse = await fetch(`${api}/api/content/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ articleId: id, packageRoot: item.packageRoot }) });
  check(`${id}: live runtime preview HTTP`, previewResponse.ok, `HTTP ${previewResponse.status}`);
  if (previewResponse.ok) {
    const preview = await previewResponse.json();
    check(`${id}: runtime WeChat preview no error`, !preview.wechatPreviewError, preview.wechatPreviewError ?? 'none');
    check(`${id}: runtime preview title`, preview.title === item.title, preview.title);
    check(`${id}: runtime preview has 4 canonical assets`, preview.assets.length === 4 && preview.assets.map(x => x.filename).join('|') === expectedNames.join('|'), preview.assets.map(x => x.filename).join('|'));
    const previewWechat = preview.payloads.wechat_official_account;
    check(`${id}: runtime preview preserves inline order`, expectedNames.every((name, index) => previewWechat.indexOf(name) >= 0 && (index === 0 || previewWechat.indexOf(name) > previewWechat.indexOf(expectedNames[index - 1]))), 'cover plus 3 body figures remain in source order');
  }
  for (const asset of item.assets) {
    const url = `${api}/api/content/asset?path=${encodeURIComponent(asset.path)}&revision=${encodeURIComponent(asset.revision)}`;
    const response = await fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expectedHash = manifest.asset_sources[asset.filename].sha256;
    check(`${id}: image readback ${asset.filename}`, response.status === 200 && hash(bytes) === asset.sha256 && hash(bytes) === expectedHash && response.headers.get('x-asset-revision') === asset.revision, `HTTP=${response.status}; sha256=${hash(bytes)}`);
  }
}

const output = {
  task_id: 'VB-CONTENT-PUBLISH-RUNTIME-20260923-072-073',
  run_at: new Date().toISOString(),
  status: failures.length ? 'BLOCKED' : 'READY_TO_PUBLISH',
  publication_performed: false,
  platform_side_effects: 0,
  approval_authorized: false,
  candidates_found: candidateItems.length,
  assertions,
  blockers: failures,
};
const outputPath = join(project, 'output/VB-CONTENT-PUBLISH-RUNTIME-20260923-072-073.json');
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ status: output.status, assertions: assertions.length, passed: assertions.filter(x => x.status === 'PASS').length, failed: failures, outputPath }, null, 2));
if (failures.length) process.exitCode = 1;
