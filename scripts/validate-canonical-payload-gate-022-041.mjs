import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {ContentLibrary} from '../src/content-library.ts';

const contentRoot=resolve(process.argv[2]||'../Content-Library');
const out=resolve(process.argv[3]||'output/canonical-payload-gate-20260923-005.json');
const library=new ContentLibrary({roots:[contentRoot]});
const items=library.index(),rows=[];
const forbidden=/(?:schema_version\s*:|content_id\s*:|storyline_id\s*:|narrative_mode\s*:|【(?:平台适配方向|Facebook适配|Facebook版本|小红书适配|小红书版本|正文高密度信息图规格|INTERNAL QA[^】]*|正文高密度信息图)】|\b(?:FACT_QA|ASSET_QA|PUBLISHER_QA|FINAL_STATUS)\s*:)/iu;
for(let number=22;number<=41;number++){
  const id=`VBE-20260916-${String(number).padStart(3,'0')}`,matches=items.filter(item=>item.articleId===id),item=matches[0];
  const payloadPath=item?.payloads.wechat_official_account,payload=payloadPath?readFileSync(payloadPath,'utf8'):'';
  const titleInPayload=payload.split(/\r?\n/).find(line=>line.startsWith('# '))?.slice(2).trim();
  const figureCaption=(payload.match(/^图\s*01｜.+$/mu)||[])[0],sourceCaption=payload.match(/^VietBridge 驻越经营实录｜原创管理工具$/mu)?.[0];
  const unique=matches.length===1&&item?.duplicateCandidates===0,assetPass=item?.assets.length===1&&item.assets[0].sourceDocId===item.canonicalDocument.driveFileId;
  const isolationPass=Boolean(payload)&&!forbidden.test(payload),captionPass=Boolean(figureCaption&&sourceCaption),titlePass=Boolean(item&&titleInPayload===item.title),canonicalPass=Boolean(item?.canonicalSource&&item.canonicalDocument.driveFileId);
  const dryRunPass=Boolean(item&&library.resolve({mode:'article_id',value:id,platforms:['wechat_official_account']}).status==='MATCHED');
  const pass=Boolean(unique&&assetPass&&isolationPass&&captionPass&&titlePass&&canonicalPass&&dryRunPass&&item?.readiness==='READY');
  rows.push({content_id:id,canonical_source:canonicalPass?'PASS':'FAIL',drive_file_id:item?.canonicalDocument.driveFileId,title:item?.title,title_match:titlePass?'PASS':'FAIL',payload_isolation:isolationPass?'PASS':'FAIL',asset_binding:assetPass?'PASS':'FAIL',caption_source:captionPass?'PASS':'FAIL',dry_run_readback:dryRunPass?'PASS':'FAIL',canonical_candidates:matches.length,duplicate_candidates:item?.duplicateCandidates??null,final_local_status:pass?'READY':'BLOCKED',blocking_reasons:item?.blockingReasons??[],payload_sha256:payload?createHash('sha256').update(payload).digest('hex'):null,asset_sha256:item?.assets[0]?.sha256??null});
}
const report={task_id:'VB-PUBLISHER-CANONICAL-PAYLOAD-GATE-20260923-005',generated_at:new Date().toISOString(),publish_side_effects:0,total:rows.length,ready:rows.filter(row=>row.final_local_status==='READY').length,blocked:rows.filter(row=>row.final_local_status!=='READY').length,duplicate_count:rows.reduce((sum,row)=>sum+Math.max(0,row.canonical_candidates-1),0),internal_qa_leakage:rows.filter(row=>row.payload_isolation!=='PASS').length,platform_variant_leakage:rows.filter(row=>row.payload_isolation!=='PASS').length,placeholder_leakage:rows.filter(row=>row.payload_isolation!=='PASS').length,rows};
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
if(report.ready!==20||report.duplicate_count||report.internal_qa_leakage)process.exitCode=1;
