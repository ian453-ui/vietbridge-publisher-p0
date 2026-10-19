import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';

type BatchItem={content_id:string;title:string;cover_asset:string;body_asset?:string;body_assets?:string[];source_urls?:string[]};
type BatchManifest={batch?:string;status?:string;items?:BatchItem[]};

export function importProductionBatch(sourceRoot:string,targetRoot:string,source:{driveDocumentId?:string;driveFolderId?:string}={}){
  const root=resolve(sourceRoot),manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')) as BatchManifest,items=manifest.items??[],results=[];
  for(const item of items){
    if(!/^VBE-\d{8}-\d{3}$/.test(item.content_id))continue;
    const markdownPath=join(root,'markdown',`${item.content_id}.md`);if(!existsSync(markdownPath))continue;
    const markdown=readFileSync(markdownPath,'utf8'),dir=join(resolve(targetRoot),item.content_id);mkdirSync(dir,{recursive:true});
    const assetNames=[item.cover_asset,...(item.body_assets??(item.body_asset?[item.body_asset]:[]))].filter(Boolean),missing=assetNames.filter(name=>!existsSync(join(root,'images',name)));
    if(missing.length)throw Error(`${item.content_id} 缺少资产：${missing.join('、')}`);
    for(const name of assetNames)cpSync(join(root,'images',name),join(dir,name));
    const publicCopy=buildPublicCopy(markdown,item.title);
    writeFileSync(join(dir,`${item.content_id}-wechat-public.md`),publicCopy.wechat);
    writeFileSync(join(dir,`${item.content_id}-facebook-public.txt`),publicCopy.facebook);
    writeFileSync(join(dir,`${item.content_id}-xiaohongshu-public.txt`),publicCopy.xiaohongshu);
    writeFileSync(join(dir,`${item.content_id}-linkedin-public.txt`),publicCopy.linkedin);
    const manifestPath=join(dir,'manifest.json');let previous:Record<string,unknown>={};try{previous=JSON.parse(readFileSync(manifestPath,'utf8')) as Record<string,unknown>;}catch{/* first import */}
    const previousActive=Array.isArray(previous.active_assets)?previous.active_assets.map(String):[];
    const previousSources=objectRecord(previous.asset_sources);
    const preserved=previousActive.filter(name=>String(objectRecord(previousSources[name]).source_kind??'').toUpperCase()!=='BATCH_BUNDLE');
    const incomingSources=Object.fromEntries(assetNames.map((name,index)=>[name,{source_kind:'BATCH_BUNDLE',role:index===0?'COVER':'BODY_INFOGRAPHIC',sequence:index===0?0:index}]));
    writeFileSync(manifestPath,JSON.stringify({...previous,article_id:item.content_id,title:item.title,version:'drive-batch-v1',qa_status:/QA_PASS|CONTENT_QA_PASS/.test(String(manifest.status))?'PASS':'UNKNOWN',source_doc_id:source.driveDocumentId??previous.source_doc_id,source_doc_anchor:item.content_id,source_folder_id:source.driveFolderId??previous.source_folder_id,source_urls:item.source_urls??previous.source_urls??[],active_assets:[...new Set([...assetNames,...preserved])],asset_sources:{...Object.fromEntries(Object.entries(previousSources).filter(([name])=>preserved.includes(name))),...incomingSources},publication_authorized:previous.publication_authorized===true,ingestion_contract:'batch-manifest-markdown-images-v1',source_batch:manifest.batch??basename(root)},null,2)+'\n');
    results.push({articleId:item.content_id,dir,assets:assetNames.length});
  }
  return {batch:manifest.batch??basename(root),imported:results.length,items:results};
}

function buildPublicCopy(markdown:string,title:string){
  const story=section(markdown,'故事开场'),mother=section(markdown,'微信公众号母稿'),actions=section(markdown,'行动清单'),hook=section(markdown,'培训转化钩子'),facebook=section(markdown,'Facebook'),linkedin=section(markdown,'LinkedIn'),xiaohongshu=section(markdown,'小红书');
  if(!mother||!facebook||!xiaohongshu)throw Error(`公开平台文案不完整：${title}`);
  const wechat=[`# ${title}`,story,mother,actions?`## 行动清单\n${actions}`:'',hook?`## 管理训练建议\n${hook}`:''].filter(Boolean).join('\n\n').trim()+'\n';
  return {wechat,facebook:`${title}\n\n${facebook.trim()}\n`,linkedin:`${title}\n\n${linkedin.trim()}\n`,xiaohongshu:`${xiaohongshu.trim()}\n`};
}
function section(markdown:string,name:string){const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match=markdown.match(new RegExp(`【${escaped}】\\s*\\n?([\\s\\S]*?)(?=\\n【[^】]+】|$)`));return match?.[1]?.trim()??'';}
function objectRecord(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
