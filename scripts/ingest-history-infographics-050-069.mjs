import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const sourceRoot=resolve(process.argv[2]??"/tmp/vb-history-assets-050-069");
const libraryRoot=resolve(process.argv[3]??"../Content-Library");
const titles={
  "050":"融资故事不是PPT，是5张经营表","051":"Trade Remedy Evidence Pack：7类证据先放好",
  "052":"进口商不能甩给供应商的5类资料","053":"从投流到售后：6个责任点不能空着",
  "054":"工业园选址：租金之外6个先爆点","055":"靠近港口仍会延误：5个物流断点",
  "056":"工业园选址7格评分表","057":"搬厂成本不是工资差：6个隐藏成本",
  "058":"客户认证入口：5道门","059":"原产地证据链：客户同时要拿出的6类资料"
};
const driveIds={
  "050":"14Hg9oGO_GcU0_WclvCxxIAtRsusqFfFR","051":"1tffwFZLjwAGZj45yMPFvYjblU8yAPjmm","052":"1xec-hWc7vNwwMZ-T7EaaL7ztTGfMO6bv","053":"15x70rNNBOzL0hgmPXUQYj0mBb1WwulaD","054":"13u3oVVBUDUfMzLenW9Iwq55G4ziTyVyO","055":"149aOnGM4sTJxHB1w0LwusHUKMGJ_jU7V","056":"1_hxAs_bXYZ1gP0qk5tRwrrhfRCrtu7cD","057":"1Cxb8QMGYpYYTKqFIuKZ9cygcvd6FthoA","058":"1qM_N87wVAOGnmDPBMJEUT1XuZjXLMPy_","059":"1bjH2VlHgN5U05NdL_jQduCHJUtQXZKtd",
  "060":"1hEuzgEgdIC4_WUZdcxZNCxwPQjTWQIHv","061":"1G93tPM7QCoa4u-TjkChvSH74PUhsHw81","062":"1kRU0BiC7Yg6On2Cc9940bgHe1vkSXxG8","063":"1Zf-QLFAl4L-TSqL3PK23TqiMQ5vG3dPJ","064":"1oNJftQ-ut79vd-o5q-jsXdpBSTxeFbOX","065":"1aNnaVN4oo1g9NThdFqS7pRjRZm7Een1a","066":"15922RL3-4qOJvcq_yKorI0HngxEOK_-k","067":"1AiDZrMpAA8qqEoxAxaQoSMqhEuF3UPT9","068":"1O8riJ9qbPbsi1QIXlRdo38sVWODX2ibN","069":"1jRP9oynTayFfCLu7SNXGModqqCeM9sa6"
};
for(let n=50;n<=69;n++){
  const number=String(n).padStart(3,"0"),articleId=`VBE-20260920-${number}`,filename=`${articleId}_body_main_QA_PASS.png`;
  const source=join(sourceRoot,filename);
  const existing=join(libraryRoot,"Drive-Batches/VBE-20260920-060-069",articleId);
  const dir=existsSync(existing)?existing:join(libraryRoot,"Drive-Batches/VBE-20260920-050-059",articleId);
  mkdirSync(dir,{recursive:true});
  const destination=join(dir,filename); if(!existsSync(destination))copyFileSync(source,destination);
  const sourceHash=createHash("sha256").update(readFileSync(source)).digest("hex"),targetHash=createHash("sha256").update(readFileSync(destination)).digest("hex");
  if(sourceHash!==targetHash)throw new Error(`hash mismatch: ${articleId}`);
  const manifestPath=join(dir,"manifest.json");
  const manifest=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,"utf8")):{article_id:articleId,title:titles[number]??articleId,version:"history-infographic-asset-only-v1",qa_status:"PASS",publication_authorized:false,active_assets:[]};
  manifest.active_assets=[...new Set([...(manifest.active_assets??[]),filename])];
  manifest.media_revision=`history-infographic-${sourceHash.slice(0,16)}`;
  manifest.asset_sources={...(manifest.asset_sources??{}),[filename]:{role:"BODY_INFOGRAPHIC",sequence:0,source_kind:"DRIVE_MATCH",drive_file_id:driveIds[number],source_filename:filename,local_path:destination,sha256:sourceHash,semantic_label:manifest.title,visual_standard_version:"historical-high-density",candidate_only:false}};
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n");
}
console.log(JSON.stringify({ingested:20}));
