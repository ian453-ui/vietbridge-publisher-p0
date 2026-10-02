import { createHash } from 'node:crypto';
import { existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { Db } from './database.ts';
import { inspectDocxContentBundle,ingestDocxContentBundle,readDocxSourceReview } from './docx-content-ingestor.ts';

const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME='application/vnd.google-apps.document';
const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.readonly';
const KEYCHAIN_HELPER=resolve(dirname(fileURLToPath(import.meta.url)),'../scripts/mac-keychain.swift');
const SERVICE_NAME='com.vietbridge.publisher.google-drive-refresh-token';
type DriveFile={id:string;name:string;mimeType:string;modifiedTime?:string;version?:string;parents?:string[];webViewLink?:string;trashed?:boolean};
type DriveClient={listCanonicalDocs():Promise<DriveFile[]>;changes(pageToken:string):Promise<{changes:Array<{fileId:string;removed?:boolean;file?:DriveFile}>;nextPageToken?:string;newStartPageToken?:string}>;startPageToken():Promise<string>;exportDocx(id:string):Promise<Buffer>};
type SourceRow={drive_file_id:string;content_id:string;title:string;slug:string;body_fingerprint:string;asset_fingerprint:string;source_revision:string;modified_time:string;source_url:string;status:string;active:number;disposition:string;detail:string|null;package_root:string|null};
const EMPTY_BODY_SHA256=createHash('sha256').update('').digest('hex');
function contentReviewPending(status:string){const value=status.toUpperCase();return value!=='READY'&&value!=='CONTENT_VISUAL_QA_PASS'&&!/^CONTENT_QA_PASS(?:__|$)/u.test(value);}

/** Drive is canonical input only: this worker never creates or publishes Drive/Platform content. */
export class GoogleDriveCanonicalSync {
  private timer?:NodeJS.Timeout; private running?:Promise<unknown>; private queuedFull?:Promise<unknown>; private runningMode?:'auto'|'full'; private runningFull=false;
  private progress:{phase:string;done:number;total:number;contentId?:string}|null=null;
  private manifestIndex?:Map<string,string[]>;
  private readonly db:Db; private readonly contentRoot:string; private readonly drive:DriveClient; private readonly authCheck:()=>boolean;
  constructor(db:Db,contentRoot:string,drive:DriveClient,authCheck:()=>boolean=()=>Boolean(readKeychainToken())){this.db=db;this.contentRoot=contentRoot;this.drive=drive;this.authCheck=authCheck;}
  static async connect(db:Db,contentRoot:string):Promise<GoogleDriveCanonicalSync>{return new GoogleDriveCanonicalSync(db,contentRoot,await GoogleDriveCanonicalSync.makeClient());}
  static async makeClient():Promise<DriveClient>{
    const credentialsPath=process.env.GD_CREDENTIALS_PATH;
    if(!credentialsPath||!existsSync(credentialsPath))throw new Error('GOOGLE_DRIVE_OAUTH_CLIENT_CONFIG_MISSING');
    const config=JSON.parse(readFileSync(credentialsPath,'utf8')).installed;
    if(!config?.client_id||!config?.client_secret||!config?.token_uri)throw new Error('GOOGLE_DRIVE_OAUTH_CLIENT_CONFIG_INVALID');
    let cachedToken='',expiresAt=0;
    const accessToken=async()=>{
      if(cachedToken&&Date.now()<expiresAt-60_000)return cachedToken;
      const refreshToken=readKeychainToken();if(!refreshToken)throw new Error('GOOGLE_DRIVE_NOT_AUTHORIZED');
      const form=new URLSearchParams({client_id:config.client_id,client_secret:config.client_secret,refresh_token:refreshToken,grant_type:'refresh_token'});
      const response=await fetch(config.token_uri,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(30_000)});
      if(!response.ok)throw new Error(response.status===400||response.status===401?'GOOGLE_DRIVE_AUTH_EXPIRED':`GOOGLE_TOKEN_HTTP_${response.status}`);
      const token=await response.json() as {access_token?:string;expires_in?:number};if(!token.access_token)throw new Error('GOOGLE_DRIVE_ACCESS_TOKEN_MISSING');
      cachedToken=token.access_token;expiresAt=Date.now()+Math.max(60,Number(token.expires_in)||3600)*1000;return cachedToken;
    };
    const api=async(path:string,params:Record<string,string>={})=>{
      const url=new URL(`https://www.googleapis.com/drive/v3/${path}`);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
      const response=await fetch(url,{headers:{authorization:`Bearer ${await accessToken()}`},signal:AbortSignal.timeout(30_000)});
      if(!response.ok)throw new Error(`GOOGLE_DRIVE_API_HTTP_${response.status}`);return response.json() as Promise<any>;
    };
    return {
      async listCanonicalDocs(){
        const result:DriveFile[]=[];let pageToken:string|undefined;
        do{const page=await api('files',{q:`trashed = false and mimeType = '${DOC_MIME}' and fullText contains '\"驻越经营实录\"'`,fields:'nextPageToken,files(id,name,mimeType,modifiedTime,version,parents,webViewLink,trashed)',pageSize:'1000',spaces:'drive',supportsAllDrives:'true',includeItemsFromAllDrives:'true',...(pageToken?{pageToken}:{})});result.push(...(page.files??[]));pageToken=page.nextPageToken;}while(pageToken);
        return result;
      },
      async startPageToken(){const result=await api('changes/startPageToken',{supportsAllDrives:'true'});if(!result.startPageToken)throw new Error('GOOGLE_DRIVE_START_TOKEN_MISSING');return String(result.startPageToken);},
      async changes(token:string){const result=await api('changes',{pageToken:token,pageSize:'1000',spaces:'drive',supportsAllDrives:'true',includeItemsFromAllDrives:'true',fields:'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,version,parents,webViewLink,trashed))'});return {changes:(result.changes??[]).map((c:any)=>({fileId:String(c.fileId),removed:Boolean(c.removed),file:c.file as DriveFile|undefined})),nextPageToken:result.nextPageToken,newStartPageToken:result.newStartPageToken};},
      async exportDocx(id:string){const url=new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export`);url.searchParams.set('mimeType',DOCX_MIME);const response=await fetch(url,{headers:{authorization:`Bearer ${await accessToken()}`},signal:AbortSignal.timeout(90_000)});if(!response.ok)throw new Error(`GOOGLE_DRIVE_EXPORT_HTTP_${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>10_000_000)throw new Error('GOOGLE_DOC_EXPORT_EXCEEDS_10MB');return bytes;}
    };
  }
  start(){if(this.timer)return;void this.run().catch(()=>{});this.timer=setInterval(()=>{void this.run().catch(()=>{});},120_000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  run(mode:'auto'|'full'='auto'):Promise<unknown>{
    if(this.running){if(mode!=='full'||this.runningFull)return this.running;if(!this.queuedFull)this.queuedFull=this.running.then(()=>this.run('full'),()=>this.run('full')).finally(()=>{this.queuedFull=undefined;});return this.queuedFull;}
    this.runningMode=mode;this.running=this.runOnce(mode).catch(error=>{this.setState('last_error',safeError(error));throw error;}).finally(()=>{this.running=undefined;this.runningMode=undefined;this.runningFull=false;this.progress=null;});return this.running;
  }
  status(){
    const get=(key:string)=>this.db.prepare('SELECT value FROM drive_sync_state WHERE key=?').get(key) as {value:string}|undefined;
    const counts=this.db.prepare('SELECT disposition,COUNT(*) as count FROM drive_sync_documents WHERE active=1 GROUP BY disposition').all() as Array<{disposition:string;count:number}>;
    return {enabled:true,authorized:this.authCheck(),running:Boolean(this.running||this.queuedFull),queuedFull:Boolean(this.queuedFull),runningFull:this.runningFull,runningMode:this.runningMode??null,progress:this.progress,lastFullScanAt:get('last_full_scan_at')?.value??null,lastFullCompletedAt:get('last_full_completed_at')?.value??null,lastChangeCheckAt:get('last_change_check_at')?.value??null,lastError:get('last_error')?.value??null,items:this.db.prepare('SELECT COUNT(*) as count FROM drive_sync_documents WHERE active=1').get(),counts,scope:DRIVE_SCOPE,publicationSideEffects:false};
  }
  sources(){return (this.db.prepare('SELECT drive_file_id,content_id,title,source_url,status,disposition,detail,modified_time,package_root,body_fingerprint FROM drive_sync_documents WHERE active=1 ORDER BY content_id,modified_time DESC').all() as Array<SourceRow>).map(({body_fingerprint,...row})=>({...row,publicCopyPresent:body_fingerprint!==EMPTY_BODY_SHA256}));}
  approveRebind(contentId:string,driveFileId:string,packageRoot:string,confirmed:boolean){
    if(!confirmed)throw new Error('EXPLICIT_REBIND_CONFIRMATION_REQUIRED');
    const selected=this.db.prepare('SELECT * FROM drive_sync_documents WHERE active=1 AND content_id=? AND drive_file_id=?').get(contentId,driveFileId) as SourceRow|undefined;
    if(!selected)throw new Error('CANONICAL_DRIVE_SOURCE_NOT_FOUND');
    if(selected.body_fingerprint===EMPTY_BODY_SHA256)throw new Error('EXPLICIT_PUBLIC_COPY_REQUIRED');
    const existing=findArticleManifests(this.contentRoot,contentId);
    if(existing.length!==1||!existsSync(packageRoot)||realpathSync(dirname(existing[0].path))!==realpathSync(packageRoot))throw new Error('UNIQUE_EXISTING_PACKAGE_REQUIRED');
    const oldDocId=String(existing[0].data.source_doc_id??'');
    if(!oldDocId||oldDocId===driveFileId)throw new Error('NO_SOURCE_REBIND_REQUIRED');
    const approval={contentId,driveFileId,oldDocId,manifestPath:existing[0].path,sourceRevision:selected.source_revision,approvedAt:new Date().toISOString()};
    this.setState(`rebind_authorization:${contentId}`,JSON.stringify(approval));
    return {accepted:true,contentId,driveFileId,previousDriveFileId:oldDocId,approvedAt:approval.approvedAt,publicationAuthorized:false};
  }
  async previewSource(contentId:string,driveFileId:string){
    const row=this.db.prepare('SELECT source_url,modified_time,disposition,detail FROM drive_sync_documents WHERE active=1 AND content_id=? AND drive_file_id=?').get(contentId,driveFileId) as {source_url:string;modified_time:string;disposition:string;detail:string|null}|undefined;
    if(!row)throw new Error('CANONICAL_DRIVE_SOURCE_NOT_FOUND');
    const temp=mkdtempSync(join(resolve(process.env.TMPDIR||'/tmp'),'vbp-drive-review-'));
    try{const path=join(temp,'source.docx');writeFileSync(path,await this.drive.exportDocx(driveFileId));return {...readDocxSourceReview(path,contentId),driveFileId,sourceUrl:row.source_url,modifiedTime:row.modified_time,disposition:row.disposition,detail:row.detail};}
    finally{rmSync(temp,{recursive:true,force:true});}
  }
  private async runOnce(mode:'auto'|'full'){
    const now=new Date().toISOString();let cursor=this.state('page_token');const lastFull=Date.parse(this.state('last_full_scan_at')??'');const doFull=mode==='full'||!cursor||!Number.isFinite(lastFull)||Date.now()-lastFull>30*60_000;this.runningFull=doFull;
    if(doFull){this.progress={phase:'listing',done:0,total:0};const start=await this.drive.startPageToken();if(!cursor)this.setState('page_token',start);const files=await this.drive.listCanonicalDocs();const eligible=files.filter(file=>isCandidateName(file.name)||this.isTracked(file.id));this.progress={phase:'reading',done:0,total:eligible.length};const seen=new Set<string>(),failures:string[]=[];for(const file of eligible){this.progress.contentId=file.name;try{await this.processFile(file);seen.add(file.id);}catch(error){this.markPackageBlockedByDriveId(file.id,'DRIVE_SOURCE_SYNC_FAILED',safeError(error));failures.push(`${file.id}: ${safeError(error)}`);}this.progress.done++;}const tracked=this.db.prepare('SELECT DISTINCT drive_file_id FROM drive_sync_documents WHERE active=1').all() as Array<{drive_file_id:string}>;for(const item of tracked)if(!seen.has(item.drive_file_id))this.markSourceInactive(item.drive_file_id,'SOURCE_REMOVED');this.setState('last_full_scan_at',now);cursor=this.state('page_token')??start;await this.reconcileAll();this.setState('last_error',failures.length?`FULL_SCAN_PARTIAL_FAILURE (${failures.length}): ${failures.slice(0,5).join('; ')}`:'');this.setState('last_full_completed_at',new Date().toISOString());if(mode==='full')return {mode:'full',seen:seen.size,failures:failures.length,status:this.status()};}
    if(!cursor)throw new Error('GOOGLE_DRIVE_PAGE_TOKEN_MISSING');
    let token=cursor,pages=0,processed=0;this.progress={phase:'changes',done:0,total:0};
    do{let page;try{page=await this.drive.changes(token);}catch(error){if(!/GOOGLE_DRIVE_API_HTTP_(?:400|410)/u.test(safeError(error)))throw error;const fresh=await this.drive.startPageToken();this.setState('page_token',fresh);const files=await this.drive.listCanonicalDocs();const seen=new Set<string>();for(const file of files){await this.processFile(file);seen.add(file.id);}const active=this.db.prepare('SELECT DISTINCT drive_file_id FROM drive_sync_documents WHERE active=1').all() as Array<{drive_file_id:string}>;for(const item of active)if(!seen.has(item.drive_file_id))this.markSourceInactive(item.drive_file_id,'SOURCE_REMOVED');this.setState('last_full_scan_at',new Date().toISOString());await this.reconcileAll();this.setState('last_error','');return {mode:'cursor-recovered-full',seen:seen.size,status:this.status()};}for(const change of page.changes){if(change.removed||change.file?.trashed){this.markSourceInactive(change.fileId,'SOURCE_REMOVED');processed++;continue;}const file=change.file;if(!file||file.mimeType!==DOC_MIME)continue;if(!isCandidateName(file.name)&&!this.isTracked(file.id))continue;try{await this.processFile(file);}catch(error){this.markPackageBlockedByDriveId(file.id,'DRIVE_SOURCE_SYNC_FAILED',safeError(error));throw error;}processed++;}
      if(page.nextPageToken){token=page.nextPageToken;this.setState('page_token',token);}else{token=page.newStartPageToken??token;this.setState('page_token',token);}pages++;
      if(!page.nextPageToken)break;
    }while(token&&pages<100);
    this.setState('last_change_check_at',now);this.setState('last_error','');await this.reconcileAll();return {mode:'changes',pages,processed,status:this.status()};
  }
  private async processFile(file:DriveFile){
    const old=this.db.prepare('SELECT 1 FROM drive_sync_documents WHERE drive_file_id=? AND modified_time=? AND active=1 LIMIT 1').get(file.id,String(file.modifiedTime??''));
    if(old)return;
    const temp=mkdtempSync(join(resolve(process.env.TMPDIR||'/tmp'),'vbp-drive-sync-'));
    try{
      const path=join(temp,'canonical.docx'),bytes=await this.drive.exportDocx(file.id);writeFileSync(path,bytes);let inspected;
      try{inspected=inspectDocxContentBundle(path);}catch(error){const id=String(file.name.match(/VBE-\d{8}-\d{3}/u)?.[0]??'').toUpperCase();if(id){const sha=createHash('sha256').update(bytes).digest('hex'),now=new Date().toISOString();this.db.prepare(`INSERT INTO drive_sync_documents(drive_file_id,content_id,title,slug,body_fingerprint,asset_fingerprint,source_revision,modified_time,source_url,status,active,disposition,detail,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'MALFORMED',1,'IMPORT_FAILED',?,?) ON CONFLICT(drive_file_id,content_id) DO UPDATE SET source_revision=excluded.source_revision,modified_time=excluded.modified_time,status='MALFORMED',active=1,disposition='IMPORT_FAILED',detail=excluded.detail,updated_at=excluded.updated_at`).run(file.id,id,file.name,slugify(file.name),sha,sha,sha,String(file.modifiedTime??''),String(file.webViewLink??''),safeError(error),now);this.setPackageDiscoveryState(id,'DRIVE_SOURCE_SYNC_FAILED',safeError(error));return;}throw error;}
      const docs=inspected.filter(doc=>doc.series==='驻越经营实录');
      if(!docs.length){this.markSourceInactive(file.id,'SOURCE_REMOVED');return;}
      const priorIds=(this.db.prepare('SELECT DISTINCT content_id FROM drive_sync_documents WHERE active=1 AND drive_file_id=?').all(file.id) as Array<{content_id:string}>).map(row=>row.content_id);
      this.db.prepare('UPDATE drive_sync_documents SET active=0,disposition=\'SUPERSEDED_REVISION\',updated_at=? WHERE drive_file_id=?').run(new Date().toISOString(),file.id);
      const upsert=this.db.prepare(`INSERT INTO drive_sync_documents(drive_file_id,content_id,title,slug,body_fingerprint,asset_fingerprint,source_revision,modified_time,source_url,status,active,disposition,detail,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?, ?,1,'DISCOVERED',NULL,?) ON CONFLICT(drive_file_id,content_id) DO UPDATE SET title=excluded.title,slug=excluded.slug,body_fingerprint=excluded.body_fingerprint,asset_fingerprint=excluded.asset_fingerprint,source_revision=excluded.source_revision,modified_time=excluded.modified_time,source_url=excluded.source_url,status=excluded.status,active=1,disposition='DISCOVERED',detail=NULL,updated_at=excluded.updated_at`);
      for(const doc of docs)upsert.run(file.id,doc.articleId,doc.title,slugify(doc.title),doc.bodyFingerprint,doc.assetFingerprint,doc.sourceRevision,String(file.modifiedTime??''),String(file.webViewLink??`https://docs.google.com/document/d/${file.id}/edit`),doc.status,new Date().toISOString());
      const declaredIds=[...file.name.matchAll(/VBE-\d{8}-\d{3}/gu)].map(match=>match[0].toUpperCase());
      if(declaredIds.length===1&&docs.length===1&&declaredIds[0]!==docs[0].articleId)this.db.prepare("UPDATE drive_sync_documents SET disposition='IDENTITY_CONFLICT',detail='TITLE_CONTENT_ID_MISMATCH',updated_at=? WHERE drive_file_id=? AND content_id=?").run(new Date().toISOString(),file.id,docs[0].articleId);
      const numericTitle=file.name.match(/^\s*(\d{3})[｜|]/u)?.[1];
      if(numericTitle&&docs.length===1&&!docs[0].articleId.endsWith(`-${numericTitle}`))this.db.prepare("UPDATE drive_sync_documents SET disposition='IDENTITY_CONFLICT',detail='TITLE_CONTENT_ID_MISMATCH',updated_at=? WHERE drive_file_id=? AND content_id=?").run(new Date().toISOString(),file.id,docs[0].articleId);
      for(const id of priorIds)if(!docs.some(doc=>doc.articleId===id))this.setPackageDiscoveryState(id,'DRIVE_SOURCE_CONTENT_REMOVED',`Canonical Drive document ${file.id} no longer contains this content_id.`);
    }finally{rmSync(temp,{recursive:true,force:true});}
  }
  private async reconcileAll(){
    const ids=(this.db.prepare('SELECT content_id FROM drive_sync_documents WHERE active=1 GROUP BY content_id ORDER BY MAX(modified_time) DESC').all() as Array<{content_id:string}>).map(row=>row.content_id);
    this.progress={phase:'reconciling',done:0,total:ids.length};this.manifestIndex=indexArticleManifests(this.contentRoot);
    try{for(const id of ids){this.progress.contentId=id;await this.reconcile(id);this.progress.done++;}}finally{this.manifestIndex=undefined;}
  }
  private async reconcile(contentId:string){
    const rows=this.db.prepare('SELECT * FROM drive_sync_documents WHERE active=1 AND content_id=? ORDER BY modified_time DESC,drive_file_id' ).all(contentId) as SourceRow[];
    if(!rows.length)return;
    const now=new Date().toISOString();const fingerprints=new Set(rows.map(row=>[row.title,row.slug,row.body_fingerprint,row.asset_fingerprint].join('|')));
    if(rows.some(row=>row.detail==='TITLE_CONTENT_ID_MISMATCH')){const detail=`Drive 文件标题与文档内 content_id 不一致；${contentId} 已隔离。`;for(const row of rows)this.db.prepare("UPDATE drive_sync_documents SET disposition='IDENTITY_CONFLICT',detail=?,updated_at=? WHERE drive_file_id=? AND content_id=?").run(detail,now,row.drive_file_id,contentId);this.setPackageDiscoveryState(contentId,'IDENTITY_CONFLICT',detail);return;}
    if(fingerprints.size>1){const detail=`多个 Drive 文件声明同一 content_id ${contentId}，但标题/正文/图片语义指纹不一致；已隔离，未导入。`;for(const row of rows)this.db.prepare('UPDATE drive_sync_documents SET disposition=\'IDENTITY_CONFLICT\',detail=?,package_root=NULL,updated_at=? WHERE drive_file_id=? AND content_id=?').run(detail,now,row.drive_file_id,contentId);this.setPackageDiscoveryState(contentId,'IDENTITY_CONFLICT',detail);return;}
    const selected=rows[0];for(const row of rows)this.db.prepare('UPDATE drive_sync_documents SET disposition=?,detail=?,updated_at=? WHERE drive_file_id=? AND content_id=?').run(row.drive_file_id===selected.drive_file_id?'CANONICAL_SELECTED':'IDENTICAL_ALIAS',rows.length>1?'内容与图片语义指纹完全一致，保留一个 canonical 项。':null,now,row.drive_file_id,contentId);
    if(selected.body_fingerprint===EMPTY_BODY_SHA256){const detail=`Drive 原文 ${selected.drive_file_id} 有文章字段/正文，但缺少明确的公众号公开稿段；不会把未分段母稿或旧包冒充新版公开稿。`;this.setDisposition(selected.drive_file_id,'SOURCE_PUBLIC_COPY_MISSING',detail,undefined,contentId);this.setPackageDiscoveryState(contentId,'SOURCE_PUBLIC_COPY_MISSING',detail);return;}
    const sourcePending=contentReviewPending(selected.status);
    const sourcePendingDetail=`GPT 内容状态是 ${selected.status||'missing'}；原文可预览，但内容制作尚未完成。`;
    const existing=this.manifestsFor(contentId);
    const sameSource=existing.find(item=>String(item.data.source_doc_id??'')===selected.drive_file_id);
    const matchingIdentity=existing.find(item=>item.data.drive_title_slug===selected.slug&&item.data.drive_body_fingerprint===selected.body_fingerprint&&item.data.drive_asset_fingerprint===selected.asset_fingerprint);
    let reusablePackage=sameSource??matchingIdentity;
    let approvedRebind:{contentId:string;driveFileId:string;oldDocId:string;manifestPath:string;sourceRevision:string;approvedAt:string}|undefined;
    if(!reusablePackage&&existing.length===1){try{const value=JSON.parse(this.state(`rebind_authorization:${contentId}`)??'null');if(value?.contentId===contentId&&value?.driveFileId===selected.drive_file_id&&value?.oldDocId===String(existing[0].data.source_doc_id??'')&&value?.manifestPath===existing[0].path&&value?.sourceRevision===selected.source_revision){approvedRebind=value;reusablePackage=existing[0];}}catch{/* Invalid approval cannot rebind a package. */}}
    const autoRebindFrom=!reusablePackage&&rows.length===1&&existing.length===1?String(existing[0].data.source_doc_id??''):'';
    if(autoRebindFrom&&autoRebindFrom!==selected.drive_file_id)reusablePackage=existing[0];
    if(existing.length&&!reusablePackage){const detail='Publisher already contains this content_id under a different or unverified canonical Drive identity; no rebind was made.';this.setDisposition(selected.drive_file_id,'IDENTITY_CONFLICT',detail,undefined,contentId);this.setPackageDiscoveryState(contentId,'IDENTITY_CONFLICT',detail);return;}
    // A selected source is exported again only if materialization is required or its revision changed.
    const prior=this.db.prepare('SELECT package_root,source_revision FROM drive_sync_documents WHERE drive_file_id=? AND content_id=?').get(selected.drive_file_id,contentId) as {package_root:string|null;source_revision:string}|undefined;
    const targetRoot=reusablePackage?dirname(dirname(reusablePackage.path)):join(this.contentRoot,'Drive-Canonical-Auto');
    const localManifest=reusablePackage?readFileSync(reusablePackage.path,'utf8'):'';
    const manifestRevision=localManifest?((JSON.parse(localManifest) as Record<string,unknown>).drive_source_revision??''):'';
    if(prior?.package_root&&existsSync(reusablePackage?.path??'')&&manifestRevision===selected.source_revision){this.repairLegacyImageStatus(reusablePackage!.path);this.setDisposition(selected.drive_file_id,sourcePending?'SOURCE_QA_PENDING':'IMPORTED',sourcePending?sourcePendingDetail:null,prior.package_root,contentId);this.clearPackageDiscoveryState(contentId);return;}
    const temp=mkdtempSync(join(resolve(process.env.TMPDIR||'/tmp'),'vbp-drive-import-'));
    try{
      const docx=join(temp,'canonical.docx');writeFileSync(docx,await this.drive.exportDocx(selected.drive_file_id));
      const imported=ingestDocxContentBundle(docx,targetRoot,{driveFileId:selected.drive_file_id,sourceUrl:selected.source_url,includeArticleIds:[contentId]});
      const item=imported.imported.find(value=>value.articleId===contentId);if(!item)throw new Error('CANONICAL_CONTENT_NOT_MATERIALIZED');
      const manifestPath=join(item.target,'manifest.json');const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as Record<string,unknown>;
      manifest.drive_source_revision=selected.source_revision;manifest.drive_body_fingerprint=selected.body_fingerprint;manifest.drive_asset_fingerprint=selected.asset_fingerprint;manifest.drive_title_slug=selected.slug;manifest.drive_discovered_at=now;if(approvedRebind){manifest.drive_rebind_from=approvedRebind.oldDocId;manifest.drive_rebind_approved_at=approvedRebind.approvedAt;}else if(autoRebindFrom){manifest.drive_rebind_from=autoRebindFrom;manifest.drive_rebind_mode='auto_unique_source';manifest.drive_rebind_at=now;}delete manifest.drive_discovery_blocker;delete manifest.drive_discovery_detail;
      writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
      const paths=this.manifestIndex?.get(contentId);if(paths&&!paths.includes(manifestPath))paths.push(manifestPath);else if(this.manifestIndex&&!paths)this.manifestIndex.set(contentId,[manifestPath]);
      this.setDisposition(selected.drive_file_id,sourcePending?'SOURCE_QA_PENDING':'IMPORTED',sourcePending?sourcePendingDetail:null,item.target,contentId);this.clearPackageDiscoveryState(contentId);
      if(approvedRebind)this.db.prepare('DELETE FROM drive_sync_state WHERE key=?').run(`rebind_authorization:${contentId}`);
    }catch(error){const detail=safeError(error);this.setDisposition(selected.drive_file_id,'IMPORT_FAILED',detail,undefined,contentId);this.setPackageDiscoveryState(contentId,'DRIVE_SOURCE_SYNC_FAILED',detail);}finally{rmSync(temp,{recursive:true,force:true});}
  }
  private isTracked(id:string){return Boolean(this.db.prepare('SELECT 1 FROM drive_sync_documents WHERE drive_file_id=? AND active=1').get(id));}
  private state(key:string){return (this.db.prepare('SELECT value FROM drive_sync_state WHERE key=?').get(key) as {value:string}|undefined)?.value;}
  private setState(key:string,value:string){this.db.prepare('INSERT INTO drive_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,value,new Date().toISOString());}
  private setDisposition(id:string,status:string,detail:string|null,root?:string,contentId?:string){this.db.prepare(`UPDATE drive_sync_documents SET disposition=?,detail=?,package_root=COALESCE(?,package_root),updated_at=? WHERE drive_file_id=? ${contentId?'AND content_id=?':''}`).run(...[status,detail,root??null,new Date().toISOString(),id,...(contentId?[contentId]:[])]);}
  private markSourceInactive(fileId:string,disposition:string){const rows=this.db.prepare('SELECT DISTINCT content_id FROM drive_sync_documents WHERE active=1 AND drive_file_id=?').all(fileId) as Array<{content_id:string}>;this.db.prepare('UPDATE drive_sync_documents SET active=0,disposition=?,updated_at=? WHERE drive_file_id=?').run(disposition,new Date().toISOString(),fileId);for(const row of rows)this.setPackageDiscoveryState(row.content_id,disposition,`Canonical Drive source ${fileId} is no longer active.`);}
  private markPackageBlockedByDriveId(fileId:string,reason:string,detail:string){const rows=this.db.prepare('SELECT DISTINCT content_id FROM drive_sync_documents WHERE drive_file_id=?').all(fileId) as Array<{content_id:string}>;for(const row of rows)this.setPackageDiscoveryState(row.content_id,reason,detail);}
  private manifestsFor(contentId:string){if(!this.manifestIndex)return findArticleManifests(this.contentRoot,contentId);const result:Array<{path:string;data:Record<string,unknown>}>=[];for(const path of this.manifestIndex.get(contentId)??[]){try{const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;if(data.article_id===contentId)result.push({path,data});}catch{/* malformed manifests are never selected */}}return result;}
  private repairLegacyImageStatus(path:string){try{const manifest=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;if(manifest.qa_status==='FAIL'&&manifest.blocking_issue==='document contains no resolvable inline image'){manifest.qa_status='PENDING_FACT_QA';delete manifest.blocking_issue;atomicWrite(path,JSON.stringify(manifest,null,2)+'\n');}}catch{/* A malformed manifest remains blocked by normal package validation. */}}
  private setPackageDiscoveryState(contentId:string,reason:string,detail:string){for(const row of this.manifestsFor(contentId)){if(row.data.drive_discovery_blocker===reason&&row.data.drive_discovery_detail===detail)continue;const manifest={...row.data,drive_discovery_blocker:reason,drive_discovery_detail:detail};atomicWrite(row.path,JSON.stringify(manifest,null,2)+'\n');}}
  private clearPackageDiscoveryState(contentId:string){for(const row of this.manifestsFor(contentId)){if(!row.data.drive_discovery_blocker&&!row.data.drive_discovery_detail)continue;const manifest={...row.data};delete manifest.drive_discovery_blocker;delete manifest.drive_discovery_detail;atomicWrite(row.path,JSON.stringify(manifest,null,2)+'\n');}}
}

function readKeychainToken(){try{return execFileSync('/usr/bin/swift',[KEYCHAIN_HELPER,'get',SERVICE_NAME],{encoding:'utf8',timeout:10_000,stdio:['ignore','pipe','ignore']}).trim()||undefined;}catch{return undefined;}}
function isCandidateName(name:string){return /(?:VBE-\d{8}-\d{3}|(?:^|\D)0\d{2}[｜|])/u.test(name);}
function slugify(value:string){return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/gu,'');}
function findArticleManifests(root:string,id:string){const result:Array<{path:string;data:Record<string,unknown>}>=[];const visit=(dir:string,depth:number)=>{if(depth>10||!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.name==='node_modules')continue;const path=join(dir,entry.name);if(entry.isDirectory())visit(path,depth+1);else if(entry.name==='manifest.json'){try{const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;if(data.article_id===id)result.push({path,data});}catch{/* malformed manifests are never selected */}}}};visit(root,0);return result;}
function indexArticleManifests(root:string){const result=new Map<string,string[]>();const visit=(dir:string,depth:number)=>{if(depth>10||!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.name==='node_modules')continue;const path=join(dir,entry.name);if(entry.isDirectory())visit(path,depth+1);else if(entry.name==='manifest.json'){try{const id=(JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>).article_id;if(typeof id==='string'){const paths=result.get(id)??[];paths.push(path);result.set(id,paths);}}catch{/* malformed manifests are never selected */}}}};visit(root,0);return result;}
function safeError(error:unknown){return error instanceof Error?error.message.slice(0,300):'DRIVE_SYNC_FAILED';}
function atomicWrite(path:string,contents:string){const temp=`${path}.tmp-${process.pid}-${Date.now()}`;writeFileSync(temp,contents);renameSync(temp,path);}
