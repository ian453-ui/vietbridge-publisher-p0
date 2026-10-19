import {parse as parseYaml,stringify as stringifyYaml} from "yaml";
import {validWechatHeadingColor,colorWechatHeadings,normalizeWechatHeadings} from "./wechat-heading-structure.ts";
export function prepareWechatDraftMarkdown(markdown:string,fallbackTitle:string,assets:Record<string,unknown>[]):string{
  const front=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/),body=front?markdown.slice(front[0].length):markdown;
  let metadata:Record<string,unknown>={};
  if(front){
    const parsed=parseYaml(front[1]);
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))metadata=parsed as Record<string,unknown>;
  }
  const plainTitle=body.split(/\r?\n/).map(line=>line.trim()).find(Boolean)?.replace(/^#{1,6}\s+/u,'')||'';
  const title=String(metadata.title||fallbackTitle||plainTitle).trim();
  if(!title)throw new Error('公众号文章缺少正式标题，尚未提交');
  const cover=String(metadata.cover||assets.find(asset=>asset.role==='cover')?.staging_path||assets.find(asset=>String(asset.mime_detected||'').startsWith('image/'))?.staging_path||'').trim();
  if(!cover)throw new Error('公众号文章缺少封面，尚未提交');
  const headingColor=validWechatHeadingColor(metadata.heading_color);
  delete metadata.heading_color;
  metadata={...metadata,title,author:String(metadata.author||'驻越经营实录'),cover};
  // Old production documents used these standalone lines as image-placement
  // instructions. They are not public copy. Remove them deterministically;
  // the canonical body assets below are then appended in sequence.
  let assembledBody=body
    .replace(/^\s*【正文高密度信息(?:主图(?:｜[^】]+)?|图)】\s*$/gmu,'')
    .replace(/^\s*【VISUAL_ASSET_MANIFEST[^】]*】\s*$/gimu,'')
    .replace(/^\s*active_assets\s*:[^\r\n]*$/gimu,'')
    .replace(/\n{3,}/g,'\n\n')
    .replace(/^\s+/,'');
  const firstPublicLine=assembledBody.split(/\r?\n/u).find(line=>line.trim())?.trim()??'';
  const firstPublicLineText=firstPublicLine.replace(/^#{1,6}\s+/u,'').replace(/<[^>]*>/gu,'').trim();
  if(firstPublicLineText===title)assembledBody=assembledBody.replace(/^\s*[^\r\n]*(?:\r?\n|$)/u,'').replace(/^\s+/,'');
  const orderedBodyImages=assets.filter(asset=>asset.role==='gallery_image'&&String(asset.mime_detected||'').startsWith('image/'))
    .sort((a,b)=>Number(a.sequence??a.ordinal??0)-Number(b.sequence??b.ordinal??0));
  // Library payloads use portable relative image paths. Resolve those paths
  // against the frozen asset set before the WeChat renderer sees the Markdown,
  // so images stay at their authored position instead of being lost or
  // appended as a detached gallery.
  const bodyImagesByName=new Map<string,string>();
  // An authored inline reference may deliberately reuse the cover bytes in
  // the article body. Resolve against every frozen image, while still only
  // auto-inserting assets explicitly classified as gallery images below.
  // This preserves dual-use GPT/Docs images without duplicating the cover at
  // the end of articles that never referenced it inline.
  for(const asset of assets.filter(asset=>String(asset.mime_detected||'').startsWith('image/'))){
    const filename=String(asset.filename||'').toLowerCase(),staged=String(asset.staging_path||'');
    if(filename&&staged)bodyImagesByName.set(filename,staged);
  }
  assembledBody=assembledBody.replace(/(!\[[^\]]*\]\()<?([^)>\n]+)>?(\))/gu,(match,prefix,source,suffix)=>{
    const cleanSource=String(source).split(/[?#]/u,1)[0].replace(/\\/g,'/');
    const filename=cleanSource.slice(cleanSource.lastIndexOf('/')+1).toLowerCase();
    const staged=bodyImagesByName.get(filename);
    return staged?String(prefix)+'<'+staged+'>'+String(suffix):match;
  });
  const missingBodyImages=orderedBodyImages.filter(asset=>{
    const staged=String(asset.staging_path||''),original=String(asset.original_locator||''),filename=String(asset.filename||'');
    return staged&&!assembledBody.includes(staged)&&(!original||!assembledBody.includes(original))&&(!filename||!assembledBody.includes(filename));
  });
  if(missingBodyImages.length){
    let blocks=assembledBody.split(/\n\s*\n/u).map(block=>block.trim()).filter(Boolean)
      .flatMap(block=>{const lines=block.split(/\n/u).map(line=>line.trim()).filter(Boolean);return lines.length>=5?lines:[block];});
    // Older public copy often has authored paragraphs separated by single
    // newlines only. Restore those boundaries before placing unanchored legacy
    // images; otherwise the preview and WeChat renderer collapse the whole
    // article into one paragraph and can only append every image at the end.
    const insertionSlots=blocks.map((block,index)=>({block,index}))
      .filter(({block})=>!/^#{1,6}\s/u.test(block)&&!/^【[^】]+】$/u.test(block)&&!/^!\[/u.test(block))
      .map(({index})=>index);
    const insertAfter=new Map<number,string[]>();
    missingBodyImages.forEach((asset,index)=>{
      const targetOrdinal=Math.min(insertionSlots.length-1,Math.max(0,Math.floor((index+1)*insertionSlots.length/(missingBodyImages.length+1))-1));
      const target=insertionSlots[targetOrdinal]??blocks.length-1;
      const list=insertAfter.get(target)??[];
      list.push(`![正文图片 ${String(Number(asset.sequence??index+1)).padStart(2,'0')}](<${String(asset.staging_path)}>)`);
      insertAfter.set(target,list);
    });
    blocks=blocks.flatMap((block,index)=>[block,...(insertAfter.get(index)??[])]);
    assembledBody=blocks.join('\n\n');
  }
  return '---\n'+stringifyYaml(metadata,{lineWidth:0}).trimEnd()+'\n---\n\n'+colorWechatHeadings(normalizeWechatHeadings(assembledBody),headingColor);
}


export function parseXhs(text: string): { body: string; tags: string[] } {
  let document:{body?:unknown;content?:unknown;tags?:unknown}={};
  try { document=parseYaml(text) as typeof document; } catch { /* legacy public files use loose sections */ }
  const yamlBody=typeof document?.body==='string'?document.body:typeof document?.content==='string'?document.content:'';
  if(yamlBody.trim()) {
    const yamlTags=Array.isArray(document?.tags)?document.tags.map(String):[];
    return validateXhsPublicPayload(yamlBody,yamlTags);
  }
  const lines = text.split(/\r?\n/); const tags: string[] = []; const body: string[] = [];
  let section:'header'|'body'|'tags'='header'; let skippedPlainTitle=false;
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

function validateXhsPublicPayload(bodyValue:string,tagValues:string[]):{body:string;tags:string[]}{
  const body=bodyValue.trim();
  if(/^(?:body|content|tags?)\s*[:：]/imu.test(body))throw new Error('小红书公开正文含内部字段 body/content/tags，已阻止发布');
  const supplied=tagValues.map(t=>t.replace(/^[-*•\s#]+/u,'').trim()).filter(Boolean);
  const tags=completeXhsTags(body,[...new Set(supplied)]).slice(0,12);
  return {body,tags};
}

export function completeXhsTags(body:string,supplied:string[]):string[]{
  const tags=[...new Set(supplied)];
  const add=(tag:string,pattern:RegExp)=>{if(pattern.test(body)&&!tags.includes(tag))tags.push(tag);};
  add('驻越经营实录',/越南|驻越/u); add('越南经营',/越南.*(?:经营|公司|企业|投资)|(?:经营|公司|企业|投资).*越南/u);
  add('中国企业出海',/中国(?:企业|品牌)|出海/u); add('越南投资',/投资/u); add('越南公司',/公司/u);
  add('越南电商',/电商|直播销售/u); add('跨境电商',/跨境|电商/u); add('越南税务',/税务|纳税|发票/u);
  add('越南用工',/用工|劳动|员工/u); add('越南工厂',/工厂|厂房/u); add('越南财务',/财务|利润|现金|分红/u);
  return tags;
}
