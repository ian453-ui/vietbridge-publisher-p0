// Same public-copy parser for native publishing and Worker bundles.
import {parse as parseYaml} from 'yaml';
export function sourcePlatformPayload(text,title,platform){
 let payload={title,body:text,tags:[]};
 if(['xiaohongshu','wechat_channels'].includes(platform)){const parsed=parseXhs(text),declared=text.match(/^(?:title|标题)\s*[:：]\s*(.+)$/mu)?.[1];payload={title:declared?.trim()||title,...parsed};}
 if(platform==='wechat_official_account'){const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/),meta=front?parseYaml(front[1]):{};payload={...payload,title:String(meta?.title||title),author:String(meta?.author||'驻越经营实录')};}
 return payload;
}

export function parseXhs(text) {
  let document={};
  try { document=parseYaml(text); } catch { /* legacy public files use loose sections */ }
  const yamlBody=typeof document?.body==='string'?document.body:typeof document?.content==='string'?document.content:'';
  if(yamlBody.trim()) {
    const yamlTags=Array.isArray(document?.tags)?document.tags.map(String):[];
    return validateXhsPublicPayload(yamlBody,yamlTags);
  }
  const lines = text.split(/\r?\n/); const tags = []; const body = [];
  let section='header'; let skippedPlainTitle=false;
  for (const line of lines) {
    const trimmed=line.trim();
    if (/^(?:body|content)\s*[:：]\s*$/iu.test(trimmed)) { section='body'; continue; }
    if (/^(?:tags?|话题|独立话题数组)\s*[:：]\s*$/iu.test(trimmed)) { section='tags'; continue; }
    if (/^(?:title|标题)\s*[:：]/iu.test(trimmed)) continue;
    if(section==='header'&&/^(?:visibility|products|is_original|schedule(?:d_at)?)\s*[:：]/iu.test(trimmed))continue;
    if(section==='tags') { if(trimmed) tags.push(trimmed.replace(/^[-*•\s#]+/u,'')); continue; }
    if(section==='header'&&!skippedPlainTitle&&trimmed&&!/^---$/.test(trimmed)) { skippedPlainTitle=true; continue; }
    const hashTags = [...line.matchAll(/#([^#\s]+)/g)].map(match => match[1]);
    if (hashTags.length && line.trim().startsWith("#")) tags.push(...hashTags); else body.push(line);
  }
  return validateXhsPublicPayload(body.join("\n"),tags);
}

function validateXhsPublicPayload(bodyValue,tagValues){
  const body=bodyValue.trim();
  if(/^(?:body|content|tags?)\s*[:：]/imu.test(body))throw new Error('小红书公开正文含内部字段 body/content/tags，已阻止发布');
  const supplied=tagValues.map(t=>t.replace(/^[-*•\s#]+/u,'').trim()).filter(Boolean);
  const tags=completeXhsTags(body,[...new Set(supplied)]).slice(0,12);
  return {body,tags};
}

export function completeXhsTags(body,supplied){
  const tags=[...new Set(supplied)];
  const add=(tag,pattern)=>{if(pattern.test(body)&&!tags.includes(tag))tags.push(tag);};
  add('驻越经营实录',/越南|驻越/u); add('越南经营',/越南.*(?:经营|公司|企业|投资)|(?:经营|公司|企业|投资).*越南/u);
  add('中国企业出海',/中国(?:企业|品牌)|出海/u); add('越南投资',/投资/u); add('越南公司',/公司/u);
  add('越南电商',/电商|直播销售/u); add('跨境电商',/跨境|电商/u); add('越南税务',/税务|纳税|发票/u);
  add('越南用工',/用工|劳动|员工/u); add('越南工厂',/工厂|厂房/u); add('越南财务',/财务|利润|现金|分红/u);
  return tags;
}
