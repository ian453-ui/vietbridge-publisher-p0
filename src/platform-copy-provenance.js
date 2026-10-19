import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,existsSync,statSync} from 'node:fs';
import {resolve,relative,basename} from 'node:path';
import {parse as parseYaml} from 'yaml';
import {ContentLibrary,clientPublicPayload} from './publisher-core/content-library.ts';
import {parseXhs} from './publisher-core/publication-payloads.ts';
export const payloadDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function sourcePlatformPayload(text,title,platform){
 let payload={title,body:text,tags:[]};
 if(['xiaohongshu','wechat_channels'].includes(platform)){const parsed=parseXhs(text),declared=text.match(/^(?:title|标题)\s*[:：]\s*(.+)$/mu)?.[1];payload={title:declared?.trim()||title,...parsed};}
 if(platform==='wechat_official_account'){const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/),meta=front?parseYaml(front[1]):{};payload={...payload,title:String(meta?.title||title),author:String(meta?.author||'驻越经营实录')};}
 return payload;
}
function within(path,root){const real=realpathSync(path),rel=relative(realpathSync(root),real);if(!rel||rel.startsWith('..')||rel.startsWith('/'))throw Error('source outside package');return real;}
function matchingPayload(expected,actual){return ['body','title','author'].every(k=>String(expected[k]||'')===String(actual[k]||''))&&payloadDigest(expected.tags||[])===payloadDigest(actual.tags||[]);}
const blocked=()=>({allowed:false,blockedReason:'目标平台稿件来源未核实；请重新选用明确平台稿或人工核对，不能沿用历史推测文案'});
/** Read-only eligibility. Never edits variants, jobs, hashes, audit or source files. */
export function libraryPlatformEligibility(db,contentId,platform){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='group_library_imports'").get())return {allowed:true};
 const row=db.prepare('SELECT * FROM group_library_imports WHERE content_id=?').get(contentId);if(!row)return {allowed:true};
 try{
 const variants=Object.fromEntries(db.prepare('SELECT platform,payload_json FROM publisher_content_variants WHERE content_id=?').all(contentId).map(r=>[r.platform,JSON.parse(r.payload_json)])),variant=variants[platform];
 const source=JSON.parse(row.source_json||'{}'),proof=source.platform_provenance?.[platform];
 const root=realpathSync(row.source_root),manifest=resolve(root,'publisher-manifest.json'),content=db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(contentId,row.workspace);if(!content)return blocked();
 if(proof){
 if(!(proof.version===2&&['PLATFORM_FILE','SHARED_CAPTION','CLIENT_MANIFEST'].includes(proof.kind)&&proof.platform===platform&&proof.workspace===row.workspace&&proof.contentId===contentId&&proof.fingerprint===row.fingerprint&&proof.payloadHash===payloadDigest(variant)))return blocked();
 if(bytesHash(within(proof.sourcePath,root))!==proof.sourceHash)return blocked();
 if(!Array.isArray(proof.assetHashes)||!proof.assetHashes.every(a=>bytesHash(within(a.sourcePath,root))===a.sha256))return blocked();
 if(proof.manifestPath&&payloadDigest(JSON.parse(readFileSync(within(proof.manifestPath,root),'utf8')).platform_assets||null)!==proof.platformAssetsHash)return blocked();
 if(!Array.isArray(proof.mediaBindings)||proof.mediaBindings.length!==variant?.media?.length)return blocked();
 if(!proof.mediaBindings.every((b,i)=>b.ordinal===i&&b.frozenPath===variant.media[i]&&bytesHash(b.frozenPath)===b.sha256&&bytesHash(within(b.sourcePath,root))===b.sha256&&(source.assets||[]).some(a=>a.path===b.sourcePath&&a.sha256===b.sha256&&a.role===b.sourceRole)))return blocked();
 return {allowed:true};
 }
 const imported=Date.parse(content.created_at);
 const predatesImport=path=>{const s=statSync(path);return Number.isFinite(imported)&&s.mtimeMs<=imported&&s.birthtimeMs<=imported;};
 if(existsSync(manifest)){
 if(platform!=='facebook')return blocked();
 const m=JSON.parse(readFileSync(manifest,'utf8')),entry=m.items?.find(e=>e.content_id===row.article_id);if(!entry||m.status!=='READY'||entry.status!=='READY')return blocked();
 // A later same-ID approval updates the shared manifest timestamp. Rejoin the
 // old import by its exact retained selection digest and immutable media;
 // never infer from a matching title or let a new caption replace an old one.
 if(/^[a-f0-9]{64}$/.test(source.selection_revision||'')){
  const candidates=[entry,...(Array.isArray(entry.previous_revisions)?entry.previous_revisions:[])],matches=[];
  for(const [index,candidate] of candidates.entries())try{
   if(candidate.content_id!==row.article_id||candidate.status!=='READY')continue;
   const candidatePath=within(resolve(root,candidate.body_source||'READY/content/'+row.article_id+'.md'),root),raw=readFileSync(candidatePath,'utf8'),payload=clientPublicPayload(raw),names=candidate.primary_image?[candidate.primary_image]:[candidate.cover||candidate.asset_cover_path,candidate.infographic||candidate.asset_infographic_path].filter(Boolean),retained=source.assets,media=variant?.media??JSON.parse(content.media_json||'[]');
   if(!predatesImport(candidatePath)||!Array.isArray(retained)||!retained.length||retained.length!==names.length||media.length!==names.length||payload.body!==(variant?.body??content.body))continue;
   if(index>0&&(!candidate.body_source_sha256||!candidate.primary_image_sha256))continue;
   if(candidate.body_source_sha256&&candidate.body_source_sha256!==createHash('sha256').update(raw).digest('hex'))continue;
   if(!names.every((name,i)=>{const original=within(resolve(root,name),root),a=retained[i];return a.path===original&&a.role===(i===0?'cover':'gallery_image')&&a.sha256===bytesHash(original)&&a.sha256===bytesHash(media[i])&&predatesImport(original)&&basename(media[i])===`${String(i+1).padStart(2,'0')}-${basename(original)}`;}))continue;
   if(candidate.primary_image_sha256&&candidate.primary_image_sha256!==retained[0].sha256)continue;
   if(payloadDigest([raw,retained.map(a=>a.sha256)])===source.selection_revision)matches.push(index);
  }catch{}
  if(matches.length===1)return {allowed:true,sourceMethod:'EXACT_LEGACY_CLIENT_BINDING',sourceRevision:matches[0]===0?'CURRENT':'HISTORICAL'};
  if(matches.length>1)return blocked();
 }
 const path=within(resolve(root,entry.body_source||'READY/content/'+row.article_id+'.md'),root),p=clientPublicPayload(readFileSync(path,'utf8'));if(!predatesImport(path)||!predatesImport(manifest))return blocked();
 const declared=entry.primary_image?[entry.primary_image]:[entry.cover||entry.asset_cover_path,entry.infographic||entry.asset_infographic_path].filter(Boolean),retained=source.assets,media=variant?.media??JSON.parse(content.media_json||'[]');
 if(!Array.isArray(retained)||!retained.length||retained.length!==declared.length||media.length!==declared.length)return blocked();
 if(!declared.every((name,i)=>{const current=within(resolve(root,name),root),a=retained[i];return a.path===current&&a.role===(i===0?'cover':'gallery_image')&&a.sha256===bytesHash(current)&&a.sha256===bytesHash(media[i])&&predatesImport(current)&&basename(media[i])===`${String(i+1).padStart(2,'0')}-${basename(current)}`;}))return blocked();
 return p.body&&p.body===(variant?.body??content.body)?{allowed:true}:blocked();
 }
 if(!variant)return blocked();
 // New index has no inference fallbacks and cannot generate public source files.
 const item=new ContentLibrary({roots:[root],readOnly:true}).index().find(p=>p.articleId===row.article_id&&realpathSync(p.packageRoot)===root);
 const path=item?.payloads?.[platform];if(!path||!predatesImport(path))return blocked();
 const text=readFileSync(within(path,root),'utf8'),expected=sourcePlatformPayload(text,item.title,platform);
 const assets=item.variantAssets?.[platform]?.length?item.assets.filter(a=>item.variantAssets[platform].includes(a.assetId)):item.assets.filter(a=>platform==='wechat_official_account'?['cover','gallery_image'].includes(a.role):item.contentType==='video'?a.role==='video':['cover','gallery_image'].includes(a.role));
 assets.sort((a,b)=>a.ordinal-b.ordinal);
 // Restore source asset references into their existing frozen counterparts for Markdown comparison.
 expected.body=expected.body.replace(/(!\[[^\]]*\]\()<?([^)>\n]+)>?(\))/gu,(match,prefix,path,suffix)=>{const hits=(source.assets||[]).filter(a=>a.path===path||basename(a.path)===basename(path));if(hits.length!==1)return match;const index=assets.findIndex(a=>a.path===hits[0].path);return index>=0?prefix+'<'+variant.media[index]+'>'+suffix:match;});
 if(!matchingPayload(expected,variant)||assets.length!==variant.media?.length)return blocked();
 if(!Array.isArray(source.assets)||!assets.every((a,i)=>{const matches=source.assets.map((original,index)=>({original,index})).filter(x=>x.original.path===a.path&&x.original.role===a.role);if(matches.length!==1)return false;const {original,index}=matches[0];return original.sha256===bytesHash(within(a.path,root))&&original.sha256===bytesHash(variant.media[i])&&predatesImport(a.path)&&basename(variant.media[i])===`${String(index+1).padStart(2,'0')}-${basename(a.path)}`;}))return blocked();
 return {allowed:true};
 }catch{return blocked();}
}
