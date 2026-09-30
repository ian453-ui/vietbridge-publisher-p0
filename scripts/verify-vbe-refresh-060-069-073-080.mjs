import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base='http://127.0.0.1:17880';
const output=resolve(process.argv[2]??'output/VBE-060-069-073-080-ASSET-REFRESH-20260925.json');
const ids=[...Array.from({length:10},(_,i)=>`VBE-20260920-${String(60+i).padStart(3,'0')}`),'VBE-20260923-073','VBE-20260924-074','VBE-20260924-075',...Array.from({length:5},(_,i)=>`VBE-20260925-${String(76+i).padStart(3,'0')}`)];
const response=await fetch(`${base}/api/content/candidates?limit=500`);
if(!response.ok)throw new Error(`candidate API ${response.status}`);
const all=(await response.json()).candidates??[];
const rows=[];
for(const id of ids){
  const matches=all.filter(c=>c.articleId===id),candidate=matches[0];
  if(!candidate){rows.push({id,candidate_count:0,status:'NOT_RECOGNIZED'});continue;}
  const previewResponse=await fetch(`${base}/api/content/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({articleId:id})});
  const preview=previewResponse.ok?await previewResponse.json():{};
  const body=String(preview.payloads?.wechat_official_account??'');
  const firstImage=body.match(/!\[[^\]]*\]\(<([^>]+)>\)|!\[[^\]]*\]\(([^)]+)\)/u)?.[1]??body.match(/!\[[^\]]*\]\(([^)]+)\)/u)?.[1]??'';
  const assets=[];
  for(const asset of candidate.assets){
    const url=`${base}/api/content/asset?path=${encodeURIComponent(asset.path)}&revision=${encodeURIComponent(asset.revision??asset.sha256??'')}`;
    const r=await fetch(url);
    const hash=r.ok?createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'):null;
    assets.push({filename:asset.filename,role:asset.role,sequence:asset.sequence,http:r.status,sha256:asset.sha256,hash_match:hash===asset.sha256,revision_match:(r.headers.get('x-asset-revision')??'').replaceAll('"','')===(asset.revision??asset.sha256)});
  }
  const expected=id.match(/-(\d{3})$/u)?.[1];
  const isFrontload=Number(expected)<=69;
  const expectedName=`${id}_${isFrontload?'FRONTLOAD_HIGH_DENSITY':'COVER_CLEAN'}_V01.png`;
  const correctRole=assets.some(x=>x.filename===expectedName&&x.role===(isFrontload?'gallery_image':'cover'));
  const firstImageMatch=isFrontload?firstImage.endsWith(expectedName):true;
  const imageCount=(body.match(/!\[[^\]]*\]\([^)]+\)/gu)??[]).length;
  const row={id,candidate_count:matches.length,duplicateCandidates:candidate.duplicateCandidates,readiness:candidate.readiness,blockingReasons:candidate.blockingReasons,preview_http:previewResponse.status,previewSource:preview.previewSource,title_match:preview.title===candidate.title,expectedName,correctRole,firstImage,firstImageMatch,imageCount,assets};
  row.asset_refresh_verified=matches.length===1&&previewResponse.ok&&preview.previewSource==='CURRENT_LIBRARY_ASSEMBLED'&&row.title_match&&correctRole&&firstImageMatch&&assets.every(a=>a.http===200&&a.hash_match&&a.revision_match);
  rows.push(row);
}
writeFileSync(output,JSON.stringify({verified_at:new Date().toISOString(),publication_authorized:false,publish_calls:0,rows},null,2)+'\n');
console.log(JSON.stringify({output,recognised:rows.filter(r=>r.candidate_count===1).length,asset_refresh_verified:rows.filter(r=>r.asset_refresh_verified).length,ready:rows.filter(r=>r.readiness==='READY').length,blocked:rows.filter(r=>r.readiness==='BLOCKED').length,hash_failures:rows.flatMap(r=>r.assets??[]).filter(a=>!a.hash_match||!a.revision_match).length}));
