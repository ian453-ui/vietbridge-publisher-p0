import { createHash } from 'node:crypto';
import { existsSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { Db } from './database.ts';
import { inspectDocxContentBundle,ingestDocxContentBundle } from './docx-content-ingestor.ts';

const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME='application/vnd.google-apps.document';
const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.readonly';
const KEYCHAIN_HELPER=resolve(dirname(fileURLToPath(import.meta.url)),'../scripts/mac-keychain.swift');
const SERVICE_NAME='com.vietbridge.publisher.google-drive-refresh-token';
type DriveFile={id:string;name:string;mimeType:string;modifiedTime?:string;version?:string;parents?:string[];webViewLink?:string;trashed?:boolean};
type DriveClient={listCanonicalDocs():Promise<DriveFile[]>;changes(pageToken:string):Promise<{changes:Array<{fileId:string;removed?:boolean;file?:DriveFile}>;nextPageToken?:string;newStartPageToken?:string}>;startPageToken():Promise<string>;exportDocx(id:string):Promise<Buffer>};
type SourceRow={drive_file_id:string;content_id:string;title:string;slug:string;body_fingerprint:string;asset_fingerprint:string;source_revision:string;modified_time:string;source_url:string;status:string;active:number;disposition:string;detail:string|null;package_root:string|null};

/** Drive is canonical input only: this worker never creates or publishes Drive/Platform content. */
export class GoogleDriveCanonicalSync {
  private timer?:NodeJS.Timeout; private running?:Promise<unknown>;
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
      const response=await fetch(config.token_uri,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});
      if(!response.ok)throw new Error(response.status===400||response.status===401?'GOOGLE_DRIVE_AUTH_EXPIRED':`GOOGLE_TOKEN_HTTP_${response.status}`);
      const token=await response.json() as {access_token?:string;expires_in?:number};if(!token.access_token)throw new Error('GOOGLE_DRIVE_ACCESS_TOKEN_MISSING');
      cachedToken=token.access_token;expiresAt=Date.now()+Math.max(60,Number(token.expires_in)||3600)*1000;return cachedToken;
    };
    const api=async(path:string,params:Record<string,string>={})=>{
      const url=new URL(`https://www.googleapis.com/drive/v3/${path}`);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
      const response=await fetch(url,{headers:{authorization:`Bearer ${await accessToken()}`}});
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
      async exportDocx(id:string){const url=new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export`);url.searchParams.set('mimeType',DOCX_MIME);const response=await fetch(url,{headers:{authorization:`Bearer ${await accessToken()}`}});if(!response.ok)throw new Error(`GOOGLE_DRIVE_EXPORT_HTTP_${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>10_000_000)throw new Error('GOOGLE_DOC_EXPORT_EXCEEDS_10MB');return bytes;}
    };
  }
  start(){if(this.timer)return;void this.run().catch(()=>{});this.timer=setInterval(()=>{void this.run().catch(()=>{});},120_000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  run(mode:'auto'|'full'='auto'){if(this.running)return this.running;this.running=this.runOnce(mode).catch(error=>{this.setState('last_error',safeError(error));throw error;}).finally(()=>{this.running=undefined;});return this.running;}
  status(){
    const get=(key:string)=>this.db.prepare('SELECT value FROM drive_sync_state WHERE key=?').get(key) as {value:string}|undefined;
    const counts=this.db.prepare('SELECT disposition,COUNT(*) as count FROM drive_sync_documents WHERE active=1 GROUP BY disposition').all() as Array<{disposition:string;count:number}>;
    return {enabled:true,authorized:this.authCheck(),lastFullScanAt:get('last_full_scan_at')?.value??null,lastChangeCheckAt:get('last_change_check_at')?.value??null,lastError:get('last_error')?.value??null,items:this.db.prepare('SELECT COUNT(*) as count FROM drive_sync_documents WHERE active=1').get(),counts,scope:DRIVE_SCOPE,publicationSideEffects:false};
  }
  private async runOnce(mode:'auto'|'full'){
    const now=new Date().toISOString();let cursor=this.state('page_token');const lastFull=Date.parse(this.state('last_full_scan_at')??'');const doFull=mode==='full'||!cursor||!Number.isFinite(lastFull)||Date.now()-lastFull>30*60_000;
    if(doFull){const start=await this.drive.startPageToken();if(!cursor)this.setState('page_token',start);const files=await this.drive.listCanonicalDocs();const seen=new Set<string>(),failures:string[]=[];for(const file of files){try{await this.processFile(file);seen.add(file.id);}catch(error){this.markPackageBlockedByDriveId(file.id,'DRIVE_SOURCE_SYNC_FAILED',safeError(error));failures.push(`${file.id}: ${safeError(error)}`);}}const tracked=this.db.prepare('SELECT DISTINCT drive_file_id FROM drive_sync_documents WHERE active=1').all() as Array<{drive_file_id:string}>;for(const item of tracked)if(!seen.has(item.drive_file_id))this.markSourceInactive(item.drive_file_id,'SOURCE_REMOVED');this.setState('last_full_scan_at',now);cursor=this.state('page_token')??start;await this.reconcileAll();this.setState('last_error',failures.length?`FULL_SCAN_PARTIAL_FAILURE (${failures.length}): ${failures.slice(0,5).join('; ')}`:'');if(mode==='full')return {mode:'full',seen:seen.size,failures:failures.length,status:this.status()};}
    if(!cursor)throw new Error('GOOGLE_DRIVE_PAGE_TOKEN_MISSING');
    let token=cursor,pages=0,processed=0;
    do{let page;try{page=await this.drive.changes(token);}catch(error){if(!/GOOGLE_DRIVE_API_HTTP_(?:400|410)/u.test(safeError(error)))throw error;const fresh=await this.drive.startPageToken();this.setState('page_token',fresh);const files=await this.drive.listCanonicalDocs();const seen=new Set<string>();for(const file of files){await this.processFile(file);seen.add(file.id);}const active=this.db.prepare('SELECT DISTINCT drive_file_id FROM drive_sync_documents WHERE active=1').all() as Array<{drive_file_id:string}>;for(const item of active)if(!seen.has(item.drive_file_id))this.markSourceInactive(item.drive_file_id,'SOURCE_REMOVED');this.setState('last_full_scan_at',new Date().toISOString());await this.reconcileAll();this.setState('last_error','');return {mode:'cursor-recovered-full',seen:seen.size,status:this.status()};}for(const change of page.changes){if(change.removed||change.file?.trashed){this.markSourceInactive(change.fileId,'SOURCE_REMOVED');processed++;continue;}const file=change.file;if(!file||file.mimeType!==DOC_MIME)continue;if(!isCandidateName(file.name)&&!this.isTracked(file.id))continue;try{await this.processFile(file);}catch(error){this.markPackageBlockedByDriveId(file.id,'DRIVE_SOURCE_SYNC_FAILED',safeError(error));throw error;}processed++;}
      if(page.nextPageToken){token=page.nextPageToken;this.setState('page_token',token);}else{token=page.newStartPageToken??token;this.setState('page_token',token);}pages++;
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
    const ids=(this.db.prepare('SELECT DISTINCT content_id FROM drive_sync_documents WHERE active=1').all() as Array<{content_id:string}>).map(row=>row.content_id);
    for(const id of ids)await this.reconcile(id);
  }
  private async reconcile(contentId:string){
    const rows=this.db.prepare('SELECT * FROM drive_sync_documents WHERE active=1 AND content_id=? ORDER BY modified_time DESC,drive_file_id' ).all(contentId) as SourceRow[];
    if(!rows.length)return;
    const now=new Date().toISOString();const fingerprints=new Set(rows.map(row=>[row.title,row.slug,row.body_fingerprint,row.asset_fingerprint].join('|')));
    if(rows.some(row=>row.detail==='TITLE_CONTENT_ID_MISMATCH')){const detail=`Drive 文件标题与文档内 content_id 不一致；${contentId} 已隔离。`;for(const row of rows)this.db.prepare("UPDATE drive_sync_documents SET disposition='IDENTITY_CONFLICT',detail=?,updated_at=? WHERE drive_file_id=? AND content_id=?").run(detail,now,row.drive_file_id,contentId);this.setPackageDiscoveryState(contentId,'IDENTITY_CONFLICT',detail);return;}
    if(fingerprints.size>1){const detail=`多个 Drive 文件声明同一 content_id ${contentId}，但标题/正文/图片语义指纹不一致；已隔离，未导入。`;for(const row of rows)this.db.prepare('UPDATE drive_sync_documents SET disposition=\'IDENTITY_CONFLICT\',detail=?,package_root=NULL,updated_at=? WHERE drive_file_id=? AND content_id=?').run(detail,now,row.drive_file_id,contentId);this.setPackageDiscoveryState(contentId,'IDENTITY_CONFLICT',detail);return;}
    const selected=rows[0];for(const row of rows)this.db.prepare('UPDATE drive_sync_documents SET disposition=?,detail=?,updated_at=? WHERE drive_file_id=? AND content_id=?').run(row.drive_file_id===selected.drive_file_id?'CANONICAL_SELECTED':'IDENTICAL_ALIAS',rows.length>1?'内容与图片语义指纹完全一致，保留一个 canonical 项。':null,now,row.drive_file_id,contentId);
    if(!/^READY$/iu.test(selected.status)){const detail=`Drive source status is ${selected.status||'missing'}; not treated as publishable.`;this.setDisposition(selected.drive_file_id,'SOURCE_QA_PENDING',detail,undefined,contentId);this.setPackageDiscoveryState(contentId,'SOURCE_QA_PENDING',detail);return;}
    const existing=findArticleManifests(this.contentRoot,contentId);
    const sameSource=existing.find(item=>String(item.data.source_doc_id??'')===selected.drive_file_id);
    const matchingIdentity=existing.find(item=>item.data.drive_title_slug===selected.slug&&item.data.drive_body_fingerprint===selected.body_fingerprint&&item.data.drive_asset_fingerprint===selected.asset_fingerprint);
    const reusablePackage=sameSource??matchingIdentity;
    if(existing.length&&!reusablePackage){const detail='Publisher already contains this content_id under a different or unverified canonical Drive identity; no rebind was made.';this.setDisposition(selected.drive_file_id,'IDENTITY_CONFLICT',detail,undefined,contentId);this.setPackageDiscoveryState(contentId,'IDENTITY_CONFLICT',detail);return;}
    // A selected source is exported again only if materialization is required or its revision changed.
    const prior=this.db.prepare('SELECT package_root,source_revision FROM drive_sync_documents WHERE drive_file_id=? AND content_id=?').get(selected.drive_file_id,contentId) as {package_root:string|null;source_revision:string}|undefined;
    const targetRoot=reusablePackage?dirname(dirname(reusablePackage.path)):join(this.contentRoot,'Drive-Canonical-Auto');
    const localManifest=reusablePackage?readFileSync(reusablePackage.path,'utf8'):'';
    const manifestRevision=localManifest?((JSON.parse(localManifest) as Record<string,unknown>).drive_source_revision??''):'';
    if(prior?.package_root&&existsSync(reusablePackage?.path??'')&&manifestRevision===selected.source_revision){this.setDisposition(selected.drive_file_id,'IMPORTED',null,prior.package_root,contentId);this.clearPackageDiscoveryState(contentId);return;}
    const temp=mkdtempSync(join(resolve(process.env.TMPDIR||'/tmp'),'vbp-drive-import-'));
    try{
      const docx=join(temp,'canonical.docx');writeFileSync(docx,await this.drive.exportDocx(selected.drive_file_id));
      const imported=ingestDocxContentBundle(docx,targetRoot,{driveFileId:selected.drive_file_id,sourceUrl:selected.source_url,includeArticleIds:[contentId]});
      const item=imported.imported.find(value=>value.articleId===contentId);if(!item)throw new Error('CANONICAL_CONTENT_NOT_MATERIALIZED');
      const manifestPath=join(item.target,'manifest.json');const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as Record<string,unknown>;
      manifest.drive_source_revision=selected.source_revision;manifest.drive_body_fingerprint=selected.body_fingerprint;manifest.drive_asset_fingerprint=selected.asset_fingerprint;manifest.drive_title_slug=selected.slug;manifest.drive_discovered_at=now;delete manifest.drive_discovery_blocker;delete manifest.drive_discovery_detail;
      writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
      this.setDisposition(selected.drive_file_id,'IMPORTED',null,item.target,contentId);this.clearPackageDiscoveryState(contentId);
    }catch(error){const detail=safeError(error);this.setDisposition(selected.drive_file_id,'IMPORT_FAILED',detail,undefined,contentId);this.setPackageDiscoveryState(contentId,'DRIVE_SOURCE_SYNC_FAILED',detail);}finally{rmSync(temp,{recursive:true,force:true});}
  }
  private isTracked(id:string){return Boolean(this.db.prepare('SELECT 1 FROM drive_sync_documents WHERE drive_file_id=? AND active=1').get(id));}
  private state(key:string){return (this.db.prepare('SELECT value FROM drive_sync_state WHERE key=?').get(key) as {value:string}|undefined)?.value;}
  private setState(key:string,value:string){this.db.prepare('INSERT INTO drive_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,value,new Date().toISOString());}
  private setDisposition(id:string,status:string,detail:string|null,root?:string,contentId?:string){this.db.prepare(`UPDATE drive_sync_documents SET disposition=?,detail=?,package_root=COALESCE(?,package_root),updated_at=? WHERE drive_file_id=? ${contentId?'AND content_id=?':''}`).run(...[status,detail,root??null,new Date().toISOString(),id,...(contentId?[contentId]:[])]);}
  private markSourceInactive(fileId:string,disposition:string){const rows=this.db.prepare('SELECT DISTINCT content_id FROM drive_sync_documents WHERE active=1 AND drive_file_id=?').all(fileId) as Array<{content_id:string}>;this.db.prepare('UPDATE drive_sync_documents SET active=0,disposition=?,updated_at=? WHERE drive_file_id=?').run(disposition,new Date().toISOString(),fileId);for(const row of rows)this.setPackageDiscoveryState(row.content_id,disposition,`Canonical Drive source ${fileId} is no longer active.`);}
  private markPackageBlockedByDriveId(fileId:string,reason:string,detail:string){const rows=this.db.prepare('SELECT DISTINCT content_id FROM drive_sync_documents WHERE drive_file_id=?').all(fileId) as Array<{content_id:string}>;for(const row of rows)this.setPackageDiscoveryState(row.content_id,reason,detail);}
  private setPackageDiscoveryState(contentId:string,reason:string,detail:string){for(const row of findArticleManifests(this.contentRoot,contentId)){const manifest={...row.data,drive_discovery_blocker:reason,drive_discovery_detail:detail};atomicWrite(row.path,JSON.stringify(manifest,null,2)+'\n');}}
  private clearPackageDiscoveryState(contentId:string){for(const row of findArticleManifests(this.contentRoot,contentId)){if(!row.data.drive_discovery_blocker&&!row.data.drive_discovery_detail)continue;const manifest={...row.data};delete manifest.drive_discovery_blocker;delete manifest.drive_discovery_detail;atomicWrite(row.path,JSON.stringify(manifest,null,2)+'\n');}}
}

function readKeychainToken(){try{return execFileSync('/usr/bin/swift',[KEYCHAIN_HELPER,'get',SERVICE_NAME],{encoding:'utf8',timeout:10_000,stdio:['ignore','pipe','ignore']}).trim()||undefined;}catch{return undefined;}}
function isCandidateName(name:string){return /(?:VBE-\d{8}-\d{3}|(?:^|\D)0\d{2}[｜|])/u.test(name);}
function slugify(value:string){return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/gu,'');}
function findArticleManifests(root:string,id:string){const result:Array<{path:string;data:Record<string,unknown>}>=[];const visit=(dir:string,depth:number)=>{if(depth>10||!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.name==='node_modules')continue;const path=join(dir,entry.name);if(entry.isDirectory())visit(path,depth+1);else if(entry.name==='manifest.json'){try{const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;if(data.article_id===id)result.push({path,data});}catch{/* malformed manifests are never selected */}}}};visit(root,0);return result;}
function safeError(error:unknown){return error instanceof Error?error.message.slice(0,300):'DRIVE_SYNC_FAILED';}
function atomicWrite(path:string,contents:string){const temp=`${path}.tmp-${process.pid}-${Date.now()}`;writeFileSync(temp,contents);renameSync(temp,path);}
