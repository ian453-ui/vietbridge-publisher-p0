import fs from 'node:fs';
import path from 'node:path';

const root='/Users/a1-6/Library/CloudStorage/GoogleDrive/My Drive/Codex/VietBridge-Social-Automation/Content-Library/Drive-Batches';
const rows=[];
for(let n=73;n<=80;n++){
  const nn=String(n).padStart(3,'0');
  const date=n===73?'20260923':n<=75?'20260924':'20260925';
  const batch=n===73?'VBE-20260923-072-073':n<=75?'VBE-20260924-074-075':'VBE-20260925-076-080';
  const id=`VBE-${date}-${nn}`;
  const dir=path.join(root,batch,id);
  const file=path.join(dir,'manifest.json');
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  const name=`${id}_COVER_CLEAN_V01.png`;
  manifest.active_assets=manifest.active_assets.filter(x=>x!==name);
  if(manifest.asset_sources?.[name]) manifest.asset_sources[name].candidate_only=true;
  manifest.visual_qa_status='PENDING';
  manifest.qa_status='PENDING_VISUAL_QA';
  manifest.blocking_issue='COVER_TOPIC_MISMATCH: ChatGPT Library 073–080 montage labels refer to a different article set; previous clean cover quarantined until exact current-article match is verified.';
  manifest.publication_authorized=false;
  manifest.asset_refresh_at=new Date().toISOString();
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
  const publicFile=path.join(dir,`${id}-wechat-public.md`);
  if(fs.existsSync(publicFile)){
    const original=fs.readFileSync(publicFile,'utf8');
    const revised=original.replace(new RegExp(`^cover:\\s*.*${name}.*\\n`,'mu'),'');
    if(revised!==original)fs.writeFileSync(publicFile,revised);
  }
  rows.push({id,quarantined:name,title:manifest.title});
}
console.log(JSON.stringify(rows,null,2));
