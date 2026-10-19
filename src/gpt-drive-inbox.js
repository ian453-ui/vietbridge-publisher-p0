import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync,renameSync} from 'node:fs';
import {extname,join,relative,resolve} from 'node:path';
import {clientPublicPayload} from './publisher-core/content-library.ts';
import {validateImage} from './image-validation.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const within=(path,root)=>{const rel=relative(realpathSync(root),realpathSync(path));return Boolean(rel&&!rel.startsWith('..')&&!rel.startsWith('/'))};
const contentId=value=>/^[A-Z][A-Z0-9-]{3,80}$/.test(String(value||''));
const imageExt=new Set(['.png','.jpg','.jpeg','.webp']);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const rootBinding=root=>{const s=statSync(root,{bigint:true});if(!s.isDirectory())throw Error('客户目录无法确认');return `${s.dev}:${s.ino}`;};
const publicRevision=(id,title,body,imageHash)=>hash(JSON.stringify([id,title,body,imageHash]));
function approvedVersion(root,entry){
 if(entry.status!=='READY'||!positive(entry.content_revision??1)||!positive(entry.visual_revision??1))throw Error('旧版本状态或版本号无法确认');
 const bodyRel=entry.body_source||`READY/content/${entry.content_id}.md`,imageRel=entry.primary_image||entry.cover||entry.asset_cover_path;
 if(!/^READY\/content\/[A-Za-z0-9_.-]+\.md$/.test(bodyRel)||typeof imageRel!=='string'||!/^READY\/assets\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp)$/i.test(imageRel)||!entry.primary_image&&(entry.infographic||entry.asset_infographic_path))throw Error('旧版本正文或单张主图引用无法确认');
 const bodyPath=resolve(root,bodyRel),imagePath=resolve(root,imageRel);
 if(!within(bodyPath,root)||!within(imagePath,root)||!statSync(bodyPath).isFile()||!statSync(imagePath).isFile())throw Error('旧版本文件无法确认');
 const source=readFileSync(bodyPath,'utf8'),payload=clientPublicPayload(source),bodyHash=hash(source),imageBytes=readFileSync(imagePath),shape=validateImage(imageBytes,extname(imagePath).toLowerCase(),entry),imageHash=hash(imageBytes);
 if(!payload.body||entry.body_source_sha256&&entry.body_source_sha256!==bodyHash||entry.primary_image_sha256&&entry.primary_image_sha256!==imageHash)throw Error('旧版本文件摘要无法确认');
 const title=payload.title||String(entry.title||entry.content_id),revision=publicRevision(entry.content_id,title,payload.body,imageHash);
 return {contentRevision:entry.content_revision??1,visualRevision:entry.visual_revision??1,title,body:payload.body,bodyHash,imageHash,shape,publicRevision:revision,token:hash(JSON.stringify([entry,bodyHash,imageHash]))};
}
const result=(entry,already_applied)=>({article_id:entry.content_id,source_id:entry.content_id,revision:entry.gpt_source_revision,content_revision:entry.content_revision,visual_revision:entry.visual_revision,already_applied});
export function approvedGptResult(root,key,revision,previousRevision){
 const manifest=JSON.parse(readFileSync(join(root,'publisher-manifest.json'),'utf8'));
 if(manifest.status!=='READY'||!Array.isArray(manifest.items))throw Error('客户资料库清单尚未就绪');
 const binding=rootBinding(root),ids=manifest.items.map(entry=>entry?.content_id);if(new Set(ids).size!==ids.length)throw Error('旧清单存在重复编号');
 for(const current of manifest.items)for(const entry of [current,...(current.previous_revisions||[])]){
  if(entry.gpt_root_identity===binding&&entry.gpt_source_key===key&&entry.gpt_source_revision===revision&&(entry.gpt_previous_revision??null)===(previousRevision??null)){approvedVersion(root,entry);return result(entry,true);}
 }
 return null;
}

export function readGptDriveInbox(root,manifest,inboxRoot){
 const inbox=inboxRoot||join(root,'GPT-INBOX');if(!existsSync(inbox))return [];
 const entries=(Array.isArray(manifest.items)?manifest.items:[]).filter(item=>item&&typeof item==='object'&&contentId(item.content_id)),existing=new Map(entries.map(item=>[item.content_id,item])),binding=rootBinding(root);
 const candidates=readdirSync(inbox,{withFileTypes:true}).filter(entry=>entry.isDirectory()).flatMap(entry=>{
  const folder=join(inbox,entry.name),file=join(folder,'submission.json');if(!existsSync(file))return [];
  let parsedId,revisionNumber=1,visualRevision=1;
  try{
   if(!within(folder,inbox)||!within(file,folder)||statSync(file).size>100000)throw Error('提交文件路径或大小无效');
   const submission=JSON.parse(readFileSync(file,'utf8'));if(submission.schema_version!==1||submission.status!=='READY_FOR_REVIEW')throw Error('提交状态或格式版本无效');
   const id=String(submission.content_id||''),title=String(submission.title||'').trim(),body=String(submission.facebook_caption||'').trim();
   if(!contentId(id)||!title||title.length>200||/[\r\n]/.test(title)||!body||body.length>20000||/Visual package only|Use the approved.*body|BODY_INFOGRAPHIC_PLACEHOLDER/i.test(body))throw Error('内容编号、标题或 Facebook 正文无效');
   parsedId=id;revisionNumber=submission.revision_number??1;visualRevision=submission.visual_revision??existing.get(id)?.visual_revision??1;
   if(!positive(revisionNumber)||!positive(visualRevision))throw Error('正文与图片版本号必须为正整数');
   const name=String(submission.primary_image||''),path=resolve(folder,name),ext=extname(name).toLowerCase();
   if(!name||!imageExt.has(ext)||!existsSync(path)||!within(path,folder))throw Error('主图缺失、格式不支持或不在提交目录内');
   const stat=statSync(path);if(!stat.isFile()||stat.size<100||stat.size>20000000)throw Error('主图大小无效');
   const imageBytes=readFileSync(path),shape=validateImage(imageBytes,ext,submission),imageHash=hash(imageBytes),payloadRevision=publicRevision(id,title,body,imageHash),revision=hash(JSON.stringify([payloadRevision,revisionNumber,visualRevision]));
   if((existing.has(id)&&![revision,payloadRevision].includes(existing.get(id).gpt_source_revision)||revisionNumber>1||submission.primary_image_sha256!==undefined)&&submission.primary_image_sha256!==imageHash)throw Error('新版主图尚未同步完成或校验失败');
   return [{key:hash([binding,folder,id].join('|')),legacyKey:hash([folder,id].join('|')),revision,payloadRevision,articleId:id,version:'gpt-drive-'+revision.slice(0,12),revisionNumber,visualRevision,visualRevisionExplicit:submission.visual_revision!==undefined,title,contentType:'image_text',body,
    assets:[{...shape,path,role:'cover',size:stat.size,mtime:stat.mtimeMs,sha256:imageHash,revision:imageHash}],packageRoot:folder,ready:false,reviewStatus:existing.has(id)?'UPDATE_AVAILABLE':'PENDING_REVIEW',blockingReason:existing.has(id)?'请核对旧版与新版；确认后只更新资料库当前版本，旧任务保持原冻结版本':'待您审核正文与主图',sourcePath:file}];
  }catch(error){return [{key:hash([binding,folder].join('|')),revision:'invalid',articleId:parsedId||entry.name,revisionNumber:positive(revisionNumber)?revisionNumber:Number.MAX_SAFE_INTEGER,visualRevision:positive(visualRevision)?visualRevision:Number.MAX_SAFE_INTEGER,version:'gpt-drive-invalid',title:entry.name,contentType:'image_text',body:'',assets:[],packageRoot:folder,ready:false,reviewStatus:'INVALID',blockingReason:String(error.message||error)}];}
 });
 const groups=new Map();for(const item of candidates){const group=groups.get(item.articleId)||[];group.push(item);groups.set(item.articleId,group);}
 return [...groups.values()].flatMap(group=>{
  const c=Math.max(...group.map(item=>item.revisionNumber)),v=Math.max(...group.filter(item=>item.revisionNumber===c).map(item=>item.visualRevision));
  const versions=group.filter(item=>item.revisionNumber===c&&item.visualRevision===v).sort((a,b)=>a.packageRoot.localeCompare(b.packageRoot)),item=versions.find(item=>item.reviewStatus==='INVALID')||versions[0];if(item.reviewStatus==='INVALID')return [item];
  if(new Set(versions.map(row=>row.revision)).size>1)return [{...item,reviewStatus:'VERSION_CONFLICT',blockingReason:'同一正文与图片版本号存在不同内容，不能静默覆盖'}];
  const entry=existing.get(item.articleId);if(!entry)return [item];
  // Preserve recognition of packages approved before numeric revision metadata existed.
  if(entry.content_revision===undefined&&entry.visual_revision===undefined&&[item.revision,item.payloadRevision].includes(entry.gpt_source_revision))return [];
  try{
   if(entries.filter(row=>row.content_id===item.articleId).length!==1||manifest.status!=='READY')throw Error('旧清单存在重复编号或未就绪');
   const previous=approvedVersion(root,entry);
   const known=[{content_revision:previous.contentRevision,visual_revision:previous.visualRevision,public_revision:previous.publicRevision},...(entry.previous_revisions||[])].find(row=>row.content_revision===c&&row.visual_revision===v);
   if(known)return known.public_revision===item.payloadRevision?[]:[{...item,reviewStatus:'VERSION_CONFLICT',blockingReason:'同一正文与图片版本号的已批准摘要不同，不能静默覆盖'}];
   const textChanged=item.title!==previous.title||item.body!==previous.body,imageChanged=item.assets[0].sha256!==previous.imageHash;
   if(c!==previous.contentRevision+Number(textChanged)||v!==previous.visualRevision+Number(imageChanged)||!textChanged&&!imageChanged||imageChanged&&!item.visualRevisionExplicit)throw Error('新版必须分别递增已改变的正文与图片版本；旧图片7的下一版是8，不能缺失、回退或跳号');
   return [{...item,previousRevision:previous.token,previousVersion:{...previous.shape,contentRevision:previous.contentRevision,visualRevision:previous.visualRevision,title:previous.title,body:previous.body,imageHash:previous.imageHash,bodyHash:previous.bodyHash}}];
  }catch(error){return [{...item,reviewStatus:'INVALID',blockingReason:String(error.message||error)}];}
 });
}

export function approveGptDriveItem(root,item,inboxRoot){
 if(!['PENDING_REVIEW','UPDATE_AVAILABLE'].includes(item.reviewStatus)||item.ready!==false)throw Error('该内容不能审核通过');
 const retry=approvedGptResult(root,item.key,item.revision,item.previousRevision);if(retry)return retry;
 const manifestPath=join(root,'publisher-manifest.json'),original=readFileSync(manifestPath,'utf8'),manifest=JSON.parse(original);
 if(manifest.status!=='READY'||!Array.isArray(manifest.items))throw Error('客户资料库清单尚未就绪');
 const current=readGptDriveInbox(root,manifest,inboxRoot).find(entry=>entry.key===item.key);
 if(!current||current.revision!==item.revision||!['PENDING_REVIEW','UPDATE_AVAILABLE'].includes(current.reviewStatus))throw Error('Drive 内容已改变，请刷新后重新审核');
 if((current.previousRevision??null)!==(item.previousRevision??null))throw Error('旧版本已改变，请重新核对');
 const old=manifest.items.find(entry=>entry.content_id===current.articleId),base=old?approvedVersion(root,old):null;
 if(old&&base.token!==current.previousRevision)throw Error('旧版本无法确认');
 const extension=extname(current.assets[0].path).toLowerCase(),assetRel=`READY/assets/${current.articleId}_gpt_${current.revision}${extension}`,contentRel=`READY/content/${current.articleId}_gpt_${current.revision}.md`,assetPath=join(root,assetRel),contentPath=join(root,contentRel),publicBody=`# ${current.title}\n\n${current.body}\n`;
 const assetBytes=readFileSync(current.assets[0].path),shape=validateImage(assetBytes,extension,{primary_image_width:current.assets[0].width,primary_image_height:current.assets[0].height});
 if(hash(assetBytes)!==current.assets[0].sha256)throw Error('Drive 主图已改变，请重新审核');
 for(const directory of ['READY/assets','READY/content'])if(!within(join(root,directory),root)||!statSync(join(root,directory)).isDirectory())throw Error('目标资料目录无法确认');
 for(const [path,expected] of [[assetPath,current.assets[0].sha256],[contentPath,hash(publicBody)]])if(existsSync(path)&&(!within(path,root)||!statSync(path).isFile()||hash(readFileSync(path))!==expected))throw Error('目标不可变文件与本次审核版本冲突');
 if(!existsSync(assetPath))writeFileSync(assetPath,assetBytes,{flag:'wx'});
 if(hash(readFileSync(assetPath))!==current.assets[0].sha256)throw Error('主图复制后校验失败');
 if(!existsSync(contentPath))writeFileSync(contentPath,publicBody,{flag:'wx'});
 const history=old?[...(old.previous_revisions||[]),{...Object.fromEntries(Object.entries(old).filter(([key])=>key!=='previous_revisions')),content_revision:base.contentRevision,visual_revision:base.visualRevision,public_revision:base.publicRevision,body_source_sha256:base.bodyHash,primary_image_sha256:base.imageHash,primary_image_width:base.shape.width,primary_image_height:base.shape.height,primary_image_format:base.shape.format}]:[];
 const next={content_id:current.articleId,title:current.title,status:'READY',content_revision:current.revisionNumber,visual_revision:current.visualRevision,body_source:contentRel,body_source_sha256:hash(publicBody),primary_image:assetRel,primary_image_sha256:current.assets[0].sha256,primary_image_width:shape.width,primary_image_height:shape.height,primary_image_format:shape.format,publish_channel:'facebook',public_revision:current.payloadRevision,gpt_root_identity:rootBinding(root),gpt_source_key:current.key,gpt_source_revision:current.revision,gpt_previous_revision:current.previousRevision??null,reviewed_at:new Date().toISOString(),reviewed_by:'user_local_ui',...(history.length?{previous_revisions:history}:{})};
 if(old)manifest.items[manifest.items.indexOf(old)]=next;else manifest.items.push(next);
 if(positive(manifest.manifest_revision))manifest.manifest_revision++;
 if(readFileSync(manifestPath,'utf8')!==original||old&&approvedVersion(root,old).token!==base.token)throw Error('客户清单或旧版本已改变，请刷新后重新审核');
 const temp=join(root,`.publisher-manifest.${process.pid}.${Date.now()}.tmp`);writeFileSync(temp,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});renameSync(temp,manifestPath);
 return result(next,false);
}
