import {clientManifestQa} from './client-manifest-qa.js';
import {sourcePlatformPayload,payloadDigest} from './platform-copy-provenance.js';
import {ContentLibrary,clientPublicPayload} from './publisher-core/content-library.ts';
import {homedir} from 'node:os';
import {join,basename,resolve,relative,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,statSync,realpathSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readGptDriveInbox,approveGptDriveItem,approvedGptResult} from './gpt-drive-inbox.js';
import {parseXhs} from './publisher-core/publication-payloads.ts';
import {parse as parseYaml} from 'yaml';
import {validateImage} from './image-validation.js';

const digest=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export class GroupLibrary {
  constructor(store,{roots,snapshotRoot,library,gptInboxBase}={}){
    this.store=store;
    const socialRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),drive=dirname(socialRoot);
    this.roots=(roots||[join(socialRoot,'Content-Library'),join(drive,'VietBridge-Enterprise-Training')]).map(resolvePath=>resolve(resolvePath));
    this.gptInboxBase=gptInboxBase===undefined?(process.env.GPT_INBOX_BASE|| (roots?null:join(homedir(),'My Drive/Codex/VietBridge-GPT-Inbox'))):gptInboxBase;
    if(this.gptInboxBase&&!this.gptInboxBase.startsWith('/'))throw new Error('GPT_INBOX_BASE 必须为绝对路径');
    this.library=library||new ContentLibrary({roots:this.roots});
    this.cache=new Map();
    this.snapshotRoot=snapshotRoot||join(homedir(),'Library/Application Support/VietBridgeSocialOperatorV2/content-snapshots');
    store.db.exec(`CREATE TABLE IF NOT EXISTS group_library_imports(content_id TEXT PRIMARY KEY,workspace TEXT NOT NULL,article_id TEXT NOT NULL,version TEXT NOT NULL,source_root TEXT NOT NULL,fingerprint TEXT NOT NULL,source_json TEXT NOT NULL,UNIQUE(workspace,fingerprint))`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS gpt_inbox_decisions(workspace TEXT NOT NULL,item_key TEXT NOT NULL,revision TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT,decided_at TEXT NOT NULL,PRIMARY KEY(workspace,item_key,revision))`);
    store.db.exec('CREATE TABLE IF NOT EXISTS publisher_content_variants(content_id TEXT NOT NULL,platform TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(content_id,platform))');
  }
  enterprise(workspace){return workspace==='ws-vietbridge'||this.store.list('workspaces').find(w=>w.id===workspace)?.library_kind==='enterprise';}
  enterpriseRoot(workspace){const row=this.store.list('workspaces').find(w=>w.id===workspace),root=row?.content_root;if(!root||!existsSync(root))throw Error('自有企业资料库需要配置已同步的本机内容目录');const real=realpathSync(root);if(!this.roots.some(base=>existsSync(base)&&(()=>{const relativePath=relative(realpathSync(base),real);return !relativePath||!relativePath.startsWith('..')&&!relativePath.startsWith('/');})()))throw Error('企业资料库不在配置的内容根目录中');return real;}
  authorize(workspace){this.store.requireWorkspace(workspace);if(this.enterprise(workspace)){if(workspace!=='ws-vietbridge')this.enterpriseRoot(workspace);return;}this.clientRoot(workspace);}
  clientRoot(workspace){
    const row=this.store.list('workspaces').find(w=>w.id===workspace);
    const configured=String(row?.content_root||'');
    const clients=join(this.roots[0],'clients');
    if(!configured||!existsSync(configured))throw new Error('该客户尚未配置已同步的本机内容目录');
    const root=realpathSync(configured),base=realpathSync(clients),rel=relative(base,root);
    if(!rel||rel.startsWith('..')||rel.startsWith('/'))throw new Error('客户内容目录必须位于独立的 clients 资源库下');
    const identity=statSync(root,{bigint:true});
    const owners=this.store.list('workspaces').filter(w=>w.content_root&&existsSync(w.content_root)&&(()=>{const s=statSync(w.content_root,{bigint:true});return s.dev===identity.dev&&s.ino===identity.ino;})());
    if(!identity.isDirectory()||owners.length!==1||owners[0].id!==workspace)throw new Error('客户内容目录必须仅归属当前 Workspace');
    return root;
  }
  inboxRoot(root){return this.gptInboxBase?join(this.gptInboxBase,basename(root)):join(root,'GPT-INBOX');}
  allowed(path){const real=realpathSync(path);if(!this.roots.some(root=>{if(!existsSync(root))return false;const rel=relative(realpathSync(root),real);return rel&&!rel.startsWith('..')&&!rel.startsWith('/');}))throw new Error('资料不在企业培训资料库内');return real;}
  items(workspace,{refresh=false}={}){
    this.authorize(workspace);
    const binding=this.enterprise(workspace)?(workspace==='ws-vietbridge'?JSON.stringify(this.roots):this.enterpriseRoot(workspace)):this.clientRoot(workspace);
    const cached=this.cache.get(workspace);
    if(!refresh&&cached&&cached.binding===binding&&Date.now()-cached.at<(this.enterprise(workspace)?300000:15000)&&cacheAssetsCurrent(cached.items))return cached.items;
    if(!this.enterprise(workspace)){
      const items=this.clientItems(workspace);
      this.cache.set(workspace,{at:Date.now(),items,binding});
      return items;
    }
    const source=workspace==='ws-vietbridge'?this.library:new ContentLibrary({roots:[this.enterpriseRoot(workspace)]});
    const items=source.index().flatMap(p=>{
      if(this.roots.some(root=>{const rel=relative(join(root,'clients'),p.packageRoot);return !rel||!rel.startsWith('..')&&!rel.startsWith('/');}))return [];
      // Shared catalogue must not require a Facebook payload for other platforms.
      let body='';
      const videos=p.assets.filter(a=>a.role==='video');
      const assets=(p.contentType==='video'?videos:p.assets.filter(a=>['cover','gallery_image'].includes(a.role))).sort((a,b)=>a.ordinal-b.ordinal);

      // Selection includes completed Page material: group destination history
      // is independent and must not inherit V1 Page publication status.
      const metadata=assets.map(a=>{const path=this.allowed(a.path),s=statSync(path),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');return {path,role:a.role,size:s.size,mtime:s.mtimeMs,sha256,revision:sha256,sourceDriveId:a.sourceDriveId};});
      const platformPayloads={};
      for(const platform of ['facebook','xiaohongshu','wechat_official_account','wechat_channels']){
        if(!p.payloads[platform])continue;
        if(!existsSync(p.payloads[platform])){platformPayloads[platform]={blockedReason:'平台文案文件尚未同步',media:[]};continue;}
        const text=readFileSync(this.allowed(p.payloads[platform]),'utf8');
        const payload=sourcePlatformPayload(text,p.title,platform);
        const ids=p.variantAssets?.[platform];
        const sourceAssets=ids?.length?p.assets.filter(a=>ids.includes(a.assetId)):p.assets.filter(a=>platform==='wechat_official_account'?['cover','gallery_image'].includes(a.role):p.contentType==='video'?a.role==='video':['cover','gallery_image'].includes(a.role));
        platformPayloads[platform]={...payload,sourceProof:{version:1,platform,kind:/\/public-payloads\//i.test(p.payloads[platform])?'SHARED_CAPTION':'PLATFORM_FILE',sourcePath:this.allowed(p.payloads[platform]),sourceHash:createHash('sha256').update(text).digest('hex'),mediaRoles:p.variantAssetRoles?.[platform]?.map(a=>a.role)},media:(ids?.length?ids.map(id=>sourceAssets.find(a=>a.assetId===id)):sourceAssets.sort((a,b)=>a.ordinal-b.ordinal)).map(a=>this.allowed(a.path))};
      }
      const defaultPlatform=Object.keys(platformPayloads).find(platform=>platformPayloads[platform].body?.trim()&&!platformPayloads[platform].blockedReason);body=defaultPlatform?platformPayloads[defaultPlatform].body.trim():'';
      const ready=Boolean(body)&&videos.length<=1&&p.readiness!=='BLOCKED';
      const blockingReason=!body?'缺少各平台公开正文':videos.length>1?'多段视频需先整理为平台支持的单段素材':p.readiness==='BLOCKED'?'内容包尚未通过原资料库发布检查':'';
      const extraAssets=[...new Set(Object.values(platformPayloads).flatMap(p=>p.media))].filter(path=>!metadata.some(a=>a.path===path)).map(path=>{const s=statSync(path),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');return {path,role:'platform_asset',size:s.size,mtime:s.mtimeMs,sha256,revision:sha256};});
      const key=digest([p.articleId,p.packageRoot,p.version]);
      return [{key,revision:digest([body,metadata,platformPayloads,extraAssets]),articleId:p.articleId,version:p.version,title:p.title,contentType:p.contentType,body,defaultPlatform,ready,blockingReason,assets:metadata,extraAssets,platformPayloads,packageRoot:p.packageRoot,...(existsSync(join(p.packageRoot,'manifest.json'))?{manifestPath:join(p.packageRoot,'manifest.json')}:{})}];
    });
    this.cache.set(workspace,{at:Date.now(),items,binding});
    return items;
  }
  // Read-only labels: legacy records are joined by their exact selection digest,
  // never by title or by assuming a missing revision means version 1.
  contentSources(workspace){
    const rows=this.store.db.prepare('SELECT * FROM group_library_imports WHERE workspace=?').all(workspace),result=new Map();
    let root,manifest;try{root=this.clientRoot(workspace);manifest=JSON.parse(readFileSync(join(root,'publisher-manifest.json'),'utf8'));}catch{}
    const positive=n=>Number.isSafeInteger(n)&&n>0;
    for(const row of rows){let source;try{source=JSON.parse(row.source_json);}catch{source={};}
      const label={article_id:row.article_id,version:row.version,revision:source.selection_revision,version_state:'UNVERIFIED'};
      const current=Array.isArray(manifest?.items)?manifest.items.filter(e=>e?.content_id===row.article_id):[];
      if(root&&current?.length===1){const candidates=[current[0],...(Array.isArray(current[0].previous_revisions)?current[0].previous_revisions:[])],matches=[];
        for(const [index,entry] of candidates.entries())try{
          if(!positive(entry.content_revision)||!positive(entry.visual_revision)||!entry.body_source_sha256||!entry.primary_image_sha256)continue;
          const confined=rel=>{if(typeof rel!=='string'||!rel.startsWith('READY/'))throw Error('SOURCE_PATH');const path=realpathSync(resolve(root,rel)),base=realpathSync(root);if(!path.startsWith(base+'/'))throw Error('SOURCE_PATH');const stat=statSync(path);if(!stat.isFile()||stat.size>20*1024*1024)throw Error('SOURCE_SIZE');return readFileSync(path);};
          const body=confined(entry.body_source).toString('utf8'),names=entry.primary_image?[entry.primary_image]:[entry.cover||entry.asset_cover_path,entry.infographic||entry.asset_infographic_path].filter(Boolean),hashes=names.map(name=>createHash('sha256').update(confined(name)).digest('hex'));
          if(digest(body)!==entry.body_source_sha256||hashes[0]!==entry.primary_image_sha256||digest([body,hashes])!==source.selection_revision)continue;
          matches.push({content_revision:entry.content_revision,visual_revision:entry.visual_revision,version_state:index===0?'CURRENT':'HISTORICAL'});
        }catch{}
        if(matches.length===1&&(!source.content_revision||source.content_revision===matches[0].content_revision)&&(!source.visual_revision||source.visual_revision===matches[0].visual_revision))Object.assign(label,matches[0]);
      }
      result.set(row.content_id,label);
    }
    return result;
  }
  clientItems(workspace){
    const root=this.clientRoot(workspace),manifestPath=join(root,'publisher-manifest.json');
    if(!existsSync(manifestPath))throw new Error('客户资源库缺少 publisher-manifest.json');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if(!Array.isArray(manifest.items))throw new Error('客户内容清单格式无效');
    const counts=new Map();for(const entry of manifest.items){const id=String(entry?.content_id||'');counts.set(id,(counts.get(id)||0)+1);}
    const approved=manifest.items.map((entry,index)=>{
      try{
      if(counts.get(String(entry?.content_id||''))!==1)throw Error('重复内容编号，须先核对来源');
      if(!entry||typeof entry!=='object'||entry.sync_error)throw Error(entry?.sync_error||'清单条目格式无效');
      const id=String(entry.content_id||''),bodySource=entry.body_source||'READY/content/'+id+'.md',contentPath=resolve(root,bodySource);
      if(!/^READY\/content\/[A-Za-z0-9_.-]+\.md$/.test(bodySource)||!realpathSync(contentPath).startsWith(realpathSync(root)+'/'))throw Error('客户正文路径无效');
      if(!/^[A-Z0-9-]+$/.test(id)||!existsSync(contentPath))throw new Error('客户内容文档缺失或编号无效：'+id);
      const source=readFileSync(contentPath,'utf8');
      if(entry.body_source_sha256&&digest(source)!==entry.body_source_sha256)throw Error('已批准正文摘要已改变');
      const {body:publicBody,title}=clientPublicPayload(source);
      const media=entry.primary_image?[entry.primary_image]:[entry.cover||entry.asset_cover_path,entry.infographic||entry.asset_infographic_path];
      const hasCover=Boolean(media[0]),missingAssets=[];
      const assets=media.filter(Boolean).flatMap((name,i)=>{
        const path=resolve(root,String(name)),rel=relative(root,path);
        if(rel.startsWith('..')||rel.startsWith('/')||!existsSync(path)||!realpathSync(path).startsWith(realpathSync(root)+'/')){missingAssets.push(String(name));return [];}
        const s=statSync(path),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
        return [{path,role:i===0?'cover':'gallery_image',size:s.size,mtime:s.mtimeMs,sha256,revision:sha256}];
      });
      if(entry.primary_image_sha256&&entry.primary_image&&assets[0]?.sha256!==entry.primary_image_sha256)throw Error('已批准主图摘要已改变');
      const imageValidation=entry.gpt_source_revision?validateImage(readFileSync(assets[0].path),extname(assets[0].path).toLowerCase(),entry):undefined;
      const documentStat=statSync(contentPath),manifestStat=statSync(manifestPath);
      const qa=clientManifestQa(manifest,entry),qaReady=String(manifest.status||'')==='READY'&&String(entry.status||'')==='READY'&&!qa.blocked;
      return {key:digest([workspace,id]),revision:digest([source,assets.map(a=>a.sha256),...(qa.explicit?[qa.states]:[])]),articleId:id,version:'client-current',...(imageValidation?{imageValidation}:{}),contentRevision:entry.content_revision??1,visualRevision:entry.visual_revision??1,revisionHistory:(entry.previous_revisions||[]).map(row=>({contentRevision:row.content_revision,visualRevision:row.visual_revision,revision:row.public_revision})),title:title||String(entry.title||id),contentType:'image_text',body:publicBody,platformPayloads:{facebook:{title:title||String(entry.title||id),body:publicBody,tags:[],sourceProof:{version:1,platform:'facebook',kind:'CLIENT_MANIFEST',sourcePath:contentPath,sourceHash:createHash('sha256').update(source).digest('hex')},media:assets.map(a=>a.path)}},assets,packageRoot:root,sourcePath:contentPath,sourceMtime:documentStat.mtimeMs,sourceSize:documentStat.size,manifestPath,manifestMtime:manifestStat.mtimeMs,ready:Boolean(publicBody&&hasCover&&!missingAssets.length&&qaReady),blockingReason:qa.blocked?'最新 QA 未通过，需重新审核':!qaReady?'内容包尚未标记 READY':!hasCover?'缺少主图引用':missingAssets.length?'清单引用的图片文件不存在':publicBody?'':'缺少已批准的 Facebook 公开正文'};
      }catch(error){const id=String(entry?.content_id||'INVALID-'+index);return {key:digest([workspace,id,index]),revision:digest(entry||null),articleId:id,title:String(entry?.title||id),version:'client-current',contentType:'image_text',body:'',assets:[],ready:false,blockingReason:'内容不可用：'+String(error.message).slice(0,180)};}
    });
    const rejected=this.store.db.prepare("SELECT item_key,revision FROM gpt_inbox_decisions WHERE workspace=? AND decision='REJECTED'").all(workspace);
    const rejectedKeys=new Set(rejected.map(item=>`${item.item_key}:${item.revision}`));
    const inbox=readGptDriveInbox(root,manifest,this.inboxRoot(root)).filter(item=>!rejectedKeys.has(`${item.key}:${item.revision}`)&&!rejectedKeys.has(`${item.legacyKey}:${item.payloadRevision}`));
    return [...inbox,...approved];
  }
  approveGpt(workspace,key,revision,previousRevision){
    if(this.enterprise(workspace))throw new Error('自有企业资料库采用已同步的正式内容；GPT 投稿请使用客户独立资料库');
    const root=this.clientRoot(workspace),retry=approvedGptResult(root,key,revision,previousRevision);if(retry)return retry;
    const item=this.items(workspace,{refresh:true}).find(p=>p.key===key);
    if(!item||item.revision!==revision)throw new Error('待审核内容已变化，请刷新后重新查看');
    if((item.previousRevision??null)!==(previousRevision??null))throw new Error('旧版本已改变或未确认，请刷新后核对旧版与新版');
    const result=approveGptDriveItem(root,item,this.inboxRoot(root));
    this.cache.delete(workspace);
    this.store.event(workspace,'gpt_drive_content_approved',result);
    return result;
  }
  rejectGpt(workspace,key,revision,reason=''){
    this.authorize(workspace);if(this.enterprise(workspace))throw new Error('自有企业资料库采用已同步的正式内容');
    const item=this.items(workspace,{refresh:true}).find(p=>p.key===key);
    if(!item||item.revision!==revision)throw new Error('待审核内容已变化，请刷新后重新查看');
    if(item.reviewStatus!=='PENDING_REVIEW'||item.ready!==false)throw new Error('该内容当前不能拒绝');
    const note=String(reason||'').trim().slice(0,500),decidedAt=new Date().toISOString();
    this.store.db.prepare(`INSERT INTO gpt_inbox_decisions(workspace,item_key,revision,decision,reason,decided_at) VALUES(?,?,?,'REJECTED',?,?) ON CONFLICT(workspace,item_key,revision) DO UPDATE SET decision='REJECTED',reason=excluded.reason,decided_at=excluded.decided_at`).run(workspace,item.key,item.revision,note||null,decidedAt);
    this.store.event(workspace,'gpt_drive_content_rejected',{article_id:item.articleId,revision:item.revision,reason:note||null});
    this.cache.delete(workspace);
    return {article_id:item.articleId,revision:item.revision,status:'REJECTED'};
  }
  catalogue(workspace,query='',refresh=false){const q=String(query??'').toLowerCase().trim();return this.items(workspace,{refresh}).filter(p=>!q||`${p.articleId} ${p.title} ${p.body}`.toLowerCase().includes(q)).map(p=>({...p,assets:p.assets.map(a=>({name:basename(a.path),role:a.role,size:a.size,revision:a.revision,sourceDriveId:a.sourceDriveId}))}));}
  catalogueSummary(workspace,query='',refresh=false){
    this.authorize(workspace);
    const binding=this.enterprise(workspace)?(workspace==='ws-vietbridge'?JSON.stringify(this.roots):this.enterpriseRoot(workspace)):this.clientRoot(workspace);
    const cached=this.cache.get(workspace);
    // List reads may use a short cache. Imports and media still validate their
    // exact source version through items(), so a stale list cannot be submitted.
    const items=!refresh&&cached?.binding===binding&&Date.now()-cached.at<60000?cached.items:this.items(workspace,{refresh:true});
    const q=String(query??'').toLowerCase().trim(),matched=items.filter(p=>!q||`${p.articleId} ${p.title} ${p.body}`.toLowerCase().includes(q));
    return {total:items.length,matched:matched.length,items:matched.map(p=>({key:p.key,revision:p.revision,articleId:p.articleId,version:p.version,title:p.title,contentType:p.contentType,assetCount:p.assets.length,ready:p.ready,blockingReason:p.blockingReason,contentRevision:p.contentRevision,visualRevision:p.visualRevision}))};
  }
  catalogueDetail(workspace,key,revision){
    const item=this.items(workspace,{refresh:true}).find(p=>p.key===key);
    if(!item||item.revision!==revision)throw Error('资料版本已变化，请刷新资料库');
    return {key:item.key,revision:item.revision,articleId:item.articleId,title:item.title,body:item.body,assets:item.assets.map(a=>({name:basename(a.path),role:a.role,size:a.size,revision:a.revision}))};
  }
  media(workspace,key,index,revision){
    this.authorize(workspace);
    const binding=this.enterprise(workspace)?(workspace==='ws-vietbridge'?JSON.stringify(this.roots):this.enterpriseRoot(workspace)):this.clientRoot(workspace);
    const cached=this.cache.get(workspace),recent=cached?.binding===binding&&Date.now()-cached.at<60000;
    let item=recent?cached.items.find(p=>p.key===key):null,asset=item?.assets[Number(index)];
    if(item?.revision===revision&&asset){try{const stat=statSync(this.allowed(asset.path));if(stat.size===asset.size&&stat.mtimeMs===asset.mtime)return asset;}catch{}}
    item=this.items(workspace,{refresh:true}).find(p=>p.key===key);
    if(!item||item.revision!==revision)throw new Error('资料版本已变化，请刷新资料库');
    asset=item.assets[Number(index)];if(!asset)throw new Error('媒体不存在');return asset;
  }
  contentMedia(workspace,contentId,index,platform){
    this.authorize(workspace);
    const content=this.store.db.prepare('SELECT media_json FROM group_content WHERE workspace=? AND id=?').get(workspace,contentId);
    const ordinal=Number(index);
    if(!content||!Number.isInteger(ordinal)||ordinal<0)throw Error('媒体不存在');
    const variant=platform?this.store.db.prepare('SELECT payload_json FROM publisher_content_variants WHERE content_id=? AND platform=?').get(contentId,platform):null;
    const path=(variant?JSON.parse(variant.payload_json).media:JSON.parse(content.media_json))[ordinal];
    if(!path||!realpathSync(path).startsWith(realpathSync(this.snapshotRoot)+'/'))throw Error('媒体不属于已冻结资料');
    return {path};
  }
  import(workspace,selections){
    this.authorize(workspace);if(!Array.isArray(selections)||!selections.length||selections.length>20)throw new Error('请选择 1–20 篇资料');
    const all=this.items(workspace,{refresh:true}),chosen=selections.map(s=>{const p=all.find(p=>p.key===s.key);if(!p||p.revision!==s.revision)throw new Error('所选资料版本已变化，请刷新后重新预览');if(p.ready===false)throw new Error(p.articleId+'：'+p.blockingReason);return p;});
    if(new Set(chosen.map(p=>p.articleId)).size!==chosen.length)throw new Error('同一内容编号只能选择一个图文或视频版本');
    const frozen=chosen.map(p=>{
      const assets=[...p.assets,...(p.extraAssets||[])].map(a=>{const bytes=readFileSync(a.path),sha256=createHash('sha256').update(bytes).digest('hex');if(p.imageValidation){if(sha256!==a.sha256)throw Error('所选主图版本已改变，请重新预览');validateImage(bytes,extname(a.path).toLowerCase(),{primary_image_width:p.imageValidation.width,primary_image_height:p.imageValidation.height});}return {...a,sha256};});
      const fingerprint=digest([2,workspace,p.articleId,p.version,p.body,assets.map(a=>a.sha256),p.platformPayloads||{}]);
      const dir=join(this.snapshotRoot,fingerprint);mkdirSync(dir,{recursive:true});
      const media=assets.map((a,i)=>{const destination=join(dir,`${String(i+1).padStart(2,'0')}-${basename(a.path)}`);if(!existsSync(destination))copyFileSync(a.path,destination);if(createHash('sha256').update(readFileSync(destination)).digest('hex')!==a.sha256)throw new Error('冻结素材哈希不一致，已阻止导入');return destination;});
      const platformPayloads=Object.fromEntries(Object.entries(p.platformPayloads||{}).map(([platform,payload])=>[platform,{...payload,body:payload.body?.replace(/(!\[[^\]]*\]\()<?([^)>\n]+)>?(\))/gu,(match,prefix,path,suffix)=>{const matches=assets.map((a,i)=>a.path===path||basename(a.path)===basename(path)?i:-1).filter(i=>i>=0);return matches.length===1?prefix+'<'+media[matches[0]]+'>'+suffix:match;}),media:payload.media.map(path=>media[assets.findIndex(a=>a.path===path)])}]));
      const platformProvenance={};for(const [platform,payload] of Object.entries(platformPayloads)){const proof=payload.sourceProof;delete payload.sourceProof;if(proof)platformProvenance[platform]={...proof,version:2,payloadHash:payloadDigest(payload),mediaBindings:payload.media.map((frozenPath,ordinal)=>{const index=media.indexOf(frozenPath),asset=assets[index];return {frozenPath,sourcePath:asset.path,sha256:asset.sha256,sourceRole:asset.role,role:proof.mediaRoles?.[ordinal]||asset.role,ordinal};}),...(p.manifestPath?{manifestPath:p.manifestPath,platformAssetsHash:payloadDigest(JSON.parse(readFileSync(p.manifestPath,'utf8')).platform_assets||null)}:{})};}
      return {p,assets,fingerprint,media:media.slice(0,p.assets.length),platformPayloads,platformProvenance};
    });
    return this.store.tx(()=>frozen.map(({p,assets,fingerprint,media,platformPayloads,platformProvenance})=>{
      const previous=this.store.db.prepare('SELECT content_id FROM group_library_imports WHERE workspace=? AND fingerprint=?').get(workspace,fingerprint);
      if(previous)return this.store.db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(previous.content_id,workspace);
      const content=this.store.createContent(workspace,{title:`${p.articleId} · ${p.title} · ${p.version}`,body:p.body,media});
      for(const proof of Object.values(platformProvenance))Object.assign(proof,{workspace,contentId:content.id,fingerprint,assetHashes:assets.map(a=>({sourcePath:a.path,sha256:a.sha256}))});
      for(const [platform,payload] of Object.entries(platformPayloads))this.store.db.prepare('INSERT INTO publisher_content_variants VALUES(?,?,?)').run(content.id,platform,JSON.stringify(payload));
      this.store.db.prepare('INSERT INTO group_library_imports VALUES(?,?,?,?,?,?,?)').run(content.id,workspace,p.articleId,p.version,p.packageRoot,fingerprint,JSON.stringify({selection_revision:p.revision,...(p.contentRevision?{content_revision:p.contentRevision,visual_revision:p.visualRevision}:{}),default_platform:p.defaultPlatform||'facebook',assets,platform_provenance:platformProvenance}));
      this.store.event(workspace,'enterprise_library_imported',{content_id:content.id,article_id:p.articleId,version:p.version,fingerprint});
      return content;
    }));
  }
}

function cacheAssetsCurrent(items){
    try{return items.every(item=>(!item.sourcePath||(()=>{const s=statSync(item.sourcePath);return s.size===item.sourceSize&&s.mtimeMs===item.sourceMtime;})())&&(!item.manifestPath||statSync(item.manifestPath).mtimeMs===item.manifestMtime)&&[...item.assets,...(item.extraAssets||[])].every(asset=>{const s=statSync(asset.path);return s.size===asset.size&&s.mtimeMs===asset.mtime;}));}
  catch{return false;}
}
