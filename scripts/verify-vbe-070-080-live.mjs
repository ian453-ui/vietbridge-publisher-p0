import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = 'http://127.0.0.1:17880';
const output = resolve(process.argv[2] ?? 'output/VB-PUBLISHER-VISIBLE-070-080-REPAIR-20260925-002.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const response = await fetch(`${base}/api/content/candidates?limit=500`);
if (!response.ok) throw new Error(`candidate API ${response.status}`);
const all = (await response.json()).candidates ?? [];
const ids = [
  'VBE-20260921-070','VBE-20260921-071','VBE-20260923-072','VBE-20260923-073',
  'VBE-20260924-074','VBE-20260924-075',
  ...['076','077','078','079','080'].map(n => `VBE-20260925-${n}`),
];
const uiObserved = new Set([...ids.slice(0,2), ...ids.slice(4)]);
const rows = [];
for (const articleId of ids) {
  const candidates = all.filter(candidate => candidate.articleId === articleId);
  const candidate = candidates[0];
  if (!candidate) { rows.push({ articleId, candidate_count: 0, final_status: 'NOT_RECOGNIZED' }); continue; }
  const previewResponse = await fetch(`${base}/api/content/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ articleId }) });
  const preview = previewResponse.ok ? await previewResponse.json() : {};
  const body = String(preview.payloads?.wechat_official_account ?? '');
  const firstImage = body.match(/!\[[^\]]*\]\(<([^>]+)>\)|!\[[^\]]*\]\(([^)]+)\)/u)?.[1] ?? body.match(/!\[[^\]]*\]\(([^)]+)\)/u)?.[1] ?? '';
  const frontload = candidate.assets.find(asset => /FRONTLOAD_HIGH_DENSITY/u.test(asset.filename));
  const assetChecks = [];
  for (const asset of candidate.assets) {
    const url = `${base}/api/content/asset?path=${encodeURIComponent(asset.path)}&revision=${encodeURIComponent(asset.revision ?? asset.sha256 ?? '')}`;
    const assetResponse = await fetch(url);
    const actualHash = assetResponse.ok ? sha256(Buffer.from(await assetResponse.arrayBuffer())) : null;
    assetChecks.push({ filename: asset.filename, http: assetResponse.status, hash_match: actualHash === asset.sha256, revision_match: (assetResponse.headers.get('x-asset-revision') ?? '').replaceAll('"','') === (asset.revision ?? asset.sha256) });
  }
  const leakage = /(?:\b(?:article_id|current_status|review_round|blocking_issues|next_action)\s*[:：]|【(?:INTERNAL|FACT_QA|ASSET_SPEC|ASSET_BINDING)|(?:READY_FOR_USER_APPROVAL|CONTENT_VISUAL_QA_PASS|PENDING_VISUAL_QA))/iu.test(body);
  const row = {
    articleId, candidate_count: candidates.length, duplicateCandidates: candidate.duplicateCandidates,
    ui_visible: uiObserved.has(articleId) ? true : null,
    preview_http: previewResponse.status, previewSource: preview.previewSource,
    title_match: preview.title === candidate.title,
    frontload_asset: frontload?.filename ?? null,
    frontload_first_in_body: Boolean(frontload && firstImage.endsWith(frontload.filename)),
    cover_role: candidate.assets.filter(asset => asset.role === 'cover').map(asset => asset.filename),
    body_assets: candidate.assets.filter(asset => asset.role === 'gallery_image').map(asset => asset.filename),
    leakage, readiness: candidate.readiness, blockingReasons: candidate.blockingReasons,
    asset_checks: assetChecks,
  };
  row.final_status = candidates.length === 1 && previewResponse.ok && preview.previewSource === 'CURRENT_LIBRARY_ASSEMBLED' && row.title_match && !leakage && assetChecks.every(check => check.http === 200 && check.hash_match && check.revision_match) && candidate.readiness === 'READY' && row.frontload_first_in_body ? 'PASS' : 'BLOCKED';
  rows.push(row);
}
writeFileSync(output, JSON.stringify({ task_id: 'VB-PUBLISHER-VISIBLE-070-080-REPAIR-20260925-002', verified_at: new Date().toISOString(), publication_authorized: false, publish_calls: 0, rows }, null, 2) + '\n');
console.log(JSON.stringify({ output, recognized: rows.filter(row => row.candidate_count === 1).length, blocked: rows.filter(row => row.final_status === 'BLOCKED').length, notRecognized: rows.filter(row => row.final_status === 'NOT_RECOGNIZED').length, hashFailures: rows.flatMap(row => row.asset_checks ?? []).filter(check => !check.hash_match || !check.revision_match).length }));
