import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = '/Users/a1-6/Library/CloudStorage/GoogleDrive/My Drive/Codex/VietBridge-Social-Automation/Content-Library/Drive-Batches';
const frontloadIds = ['1jGSWCRh25HGs9wBb0SjyQzPVZAaGw-ya','1iecbTI5C1SKb4-1zGiSyyrd1jL7tWyLf','16QdeOWrflthK3mXWMiKYDEd0Uz0v1iod','1dfg9VS5nZqAd5a8f9xeapPtEwVgKyQXO','1fR-kUv_V9RDVoEnmFYQWSyZyunmcOWvb','1gghIL6n0GpgW9lvaWZv5E5i0rmCJdpWf','15SkYc7PJW83L2Liw1vl3PRK60AyQGH5Z','1gsI3egXVhdwHnprJC_MbwAAHxOAEFuNN','1xyIVhIt-1Q8JBfHXkS-ObLZmYolxp1q2','1bAimm179KYLGs_CqPsqBUhH34v9kagwl'];
const coverIds = ['1EZr9WgoqRXR6ZLxSOmwp7y_6g5QfSRXU','1fQAsu23BDwS66RvW6L9PHTSaFSWgXaiQ','1hNAR0ya1c-E_qnXLPXLRlCEGcUQ7O_Kr','1cwclyJ_5gtnug--1m2K9lFwWQhK3mIsD','1cXO9beZHJAW0Fw7-SkkcYgRwQCpgezPp','1O_GE12UwqMWCkam2ZbM8S7W1Xd5J_p1-','1SU3O6j7OM5THPHwND_Pb1L-jfaB6Qz1L','1RIg-chu7_PvjXq1jkVk5Na0dThiVxJ-q'];
const coverNums = [73,74,75,76,77,78,79,80];
const today = new Date().toISOString();
function article(n) {
  const nn = String(n).padStart(3,'0');
  const date = n <= 69 ? '20260920' : n === 73 ? '20260923' : n <= 75 ? '20260924' : '20260925';
  const batch = n <= 69 ? 'VBE-20260920-060-069' : n === 73 ? 'VBE-20260923-072-073' : n <= 75 ? 'VBE-20260924-074-075' : 'VBE-20260925-076-080';
  const id = `VBE-${date}-${nn}`;
  return {id,dir:path.join(root,batch,id)};
}
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function writeChanged(file,content) { if(fs.readFileSync(file,'utf8')!==content) fs.writeFileSync(file,content); }
const results=[];
for(let n=60;n<=69;n++) {
  const {id,dir}=article(n);
  const manifestPath=path.join(dir,'manifest.json');
  const publicPath=path.join(dir,`${id}-wechat-public.md`);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const name=`${id}_FRONTLOAD_HIGH_DENSITY_V01.png`;
  const file=path.join(dir,name);
  if(!fs.existsSync(file)) throw new Error(`Missing image ${file}`);
  const digest=hash(file);
  const original=fs.readFileSync(publicPath,'utf8');
  let publicText=original;
  if(!publicText.includes(name)) {
    const paragraphs=publicText.split(/\n\n/u);
    if(paragraphs.length<3 || !paragraphs[0].startsWith('# ')) throw new Error(`Unexpected public body ${id}`);
    paragraphs.splice(2,0,`![${manifest.title}：正文知识首图](${name})`);
    publicText=paragraphs.join('\n\n');
  }
  const oldImage=/!\[[^\]]*\]\(([^)]+)\)/gu;
  const firstImage=[...publicText.matchAll(oldImage)][0]?.[1];
  if(firstImage!==name) throw new Error(`First body image mismatch ${id}: ${firstImage}`);
  const oldCover=manifest.active_assets.find(x=>/cover/i.test(x));
  const body=manifest.active_assets.filter(x=>x!==oldCover && x!==name);
  manifest.active_assets=[oldCover,name,...body].filter(Boolean);
  manifest.asset_sources ??={};
  for(let j=0;j<body.length;j++) if(manifest.asset_sources[body[j]]) manifest.asset_sources[body[j]].sequence=j+1;
  manifest.asset_sources[name]={role:'BODY_INFOGRAPHIC',sequence:0,source_kind:'DRIVE_EXACT_FILE',drive_file_id:frontloadIds[n-60],source_folder_id:'1FE2LO4mvCAID1Cyif8jvEdTGC7x3Bx06',source_filename:name,local_path:file,sha256:digest,semantic_label:manifest.title,visual_standard_version:'frontload-high-density-v01',candidate_only:false};
  manifest.media_revision=`frontload-${digest.slice(0,16)}`;
  manifest.asset_refresh_at=today;
  writeChanged(publicPath,publicText);
  writeChanged(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  results.push({id,role:'FRONTLOAD',sha256:digest,first_body_image:firstImage});
}
for(let i=0;i<coverNums.length;i++) {
  const n=coverNums[i],{id,dir}=article(n);
  const manifestPath=path.join(dir,'manifest.json');
  const publicPath=path.join(dir,`${id}-wechat-public.md`);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const name=`${id}_COVER_CLEAN_V01.png`,file=path.join(dir,name);
  if(!fs.existsSync(file)) throw new Error(`Missing image ${file}`);
  const digest=hash(file);
  const oldCovers=manifest.active_assets.filter(x=>/COVER/i.test(x));
  manifest.active_assets=[name,...manifest.active_assets.filter(x=>!/COVER/i.test(x))];
  manifest.asset_sources ??={};
  for(const old of oldCovers) delete manifest.asset_sources[old];
  manifest.asset_sources[name]={role:'COVER',sequence:0,source_kind:'DRIVE_EXACT_FILE',drive_file_id:coverIds[i],source_folder_id:'1HI8Jw4cAf6gspDa3K5da_p2InlGdxKYG',source_filename:name,local_path:file,sha256:digest,semantic_label:manifest.title,visual_standard_version:'clean-cover-v01',candidate_only:false};
  manifest.media_revision=`clean-cover-${digest.slice(0,16)}`;
  manifest.asset_refresh_at=today;
  if(fs.existsSync(publicPath)) {
    let publicText=fs.readFileSync(publicPath,'utf8');
    if(/^---\n/u.test(publicText)) publicText=publicText.replace(/^cover:\s*.*$/mu,`cover: ${name}`);
    for(const old of oldCovers) publicText=publicText.replace(new RegExp(`^!\\[[^\\]]*\\]\\(${old.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}\\)\\n(?:图 01[^\\n]*\\n)?(?:VietBridge 驻越经营实录｜原创管理工具\\n)?`,'gmu'),'');
    writeChanged(publicPath,publicText);
  }
  writeChanged(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  results.push({id,role:'COVER',sha256:digest,old_covers:oldCovers});
}
console.log(JSON.stringify(results,null,2));
