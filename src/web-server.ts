import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { existsSync,readFileSync,statSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./database.ts";
import { PublisherStore } from "./publisher-store.ts";
import { PLATFORM_CAPABILITIES } from "./platform-contract.ts";
import { renderDashboard } from "./web-ui.ts";
import { TaskService, type ExecuteTaskInput } from "./task-service.ts";
import { PlatformWorker, prepareWechatDraftMarkdown } from "./platform-worker.ts";
import { WechatDraftReader } from "./wechat-draft-reader.ts";
import { WechatOfficialBrowser } from "./wechat-official-browser.ts";
import {browserPageConfig} from './facebook-business-browser.ts';
import { PublicationLedgerReconciler } from "./publication-ledger.ts";
import { LocalContentRefresher } from './local-content-refresh.ts';
import {assetMime,serveAsset} from './asset-response.ts';
import {videoDetails} from './content-library.ts';
import {GoogleDriveCanonicalSync} from './google-drive-canonical-sync.ts';

export type WebServerOptions = { dbPath?: string; host?: string; port?: number; contentRoots?: string[]; ledgerPath?: string; stagingRoot?: string; mirrorPath?: string; workerEnabled?: boolean };

async function clientWorkspace(id:string):Promise<{id:string;name:string;contentRoot:string;account?:{pageId:string;name:string;configUrl:string}}> {
  if(!/^ws-[a-z0-9-]+$/i.test(id))throw new Error('客户编号无效');
  const [stateResponse,facebookResponse]=await Promise.all([
    fetch('http://127.0.0.1:17882/api/state?workspace='+encodeURIComponent(id)),
    fetch('http://127.0.0.1:17882/api/facebook?workspace='+encodeURIComponent(id))
  ]);
  if(!stateResponse.ok||!facebookResponse.ok)throw new Error('V2 客户配置暂不可读取');
  const state=await stateResponse.json() as any,facebook=await facebookResponse.json() as any;
  const workspace=state.workspaces?.find((item:any)=>item.id===id);
  if(!workspace)throw new Error('客户不存在');
  const contentRoot=String(workspace.content_root||'');
  const clientsRoot=resolve(homedir(),'Library/CloudStorage/GoogleDrive/My Drive/Codex/VietBridge-Social-Automation/Content-Library/clients');
  if(id!=='ws-vietbridge'&&(!contentRoot||!resolve(contentRoot).startsWith(clientsRoot+'/')))throw new Error('客户独立内容库未配置');
  const selected=facebook.accounts?.find((item:any)=>item.id===facebook.selectedAccountId&&item.enabled);
  return {id,name:String(workspace.name),contentRoot,account:selected?{pageId:String(selected.external_id||''),name:String(selected.display_name),configUrl:String(selected.config_url||'')}:undefined};
}

export function createPublisherServer(options: WebServerOptions = {}): Server {
  const db = openDatabase(options.dbPath ?? process.env.PUBLISHER_DB ?? resolve("data/publisher.sqlite"));
  const store = new PublisherStore(db);
  const driveRoot = resolve(homedir(), "Library/CloudStorage/GoogleDrive/My Drive/Codex");
  const socialRoot = resolve(driveRoot, "VietBridge-Social-Automation");
  const ledgerPath=options.ledgerPath ?? resolve(socialRoot, "Shared-Publication-State/shared-publication-ledger.yaml");
  const tasks = new TaskService(db, {
    roots: options.contentRoots ?? [resolve(socialRoot, "Content-Library"), resolve(driveRoot, "VietBridge-Enterprise-Training")],
    ledgerPath,
    stagingRoot: options.stagingRoot ?? resolve(socialRoot, "Publisher-P0/data/content-snapshots")
  });
  const worker = new PlatformWorker(db, options.mirrorPath ?? resolve(socialRoot, "Shared-Publication-State/publisher-events.jsonl"));
  const wechatBrowser=new WechatOfficialBrowser();
  const ledgerReconciler=new PublicationLedgerReconciler(db,tasks.library,ledgerPath);
  const localRefresh=new LocalContentRefresher(tasks.library.roots[0]??resolve(socialRoot,'Content-Library'));
  const canonicalRoot=tasks.library.roots[0]??resolve(socialRoot,'Content-Library');
  let driveSync:GoogleDriveCanonicalSync|undefined,driveSyncError='GOOGLE_DRIVE_CONNECTOR_STARTING';
  void GoogleDriveCanonicalSync.connect(db,canonicalRoot).then(sync=>{driveSync=sync;driveSyncError='';sync.start();}).catch(error=>{driveSyncError=error instanceof Error?error.message:'GOOGLE_DRIVE_SYNC_UNAVAILABLE';});
  if (options.workerEnabled !== false) worker.start();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") return html(res, renderDashboard());
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, aiRuntimeRequired: false, capabilities: PLATFORM_CAPABILITIES });
    if(req.method==='GET'&&url.pathname==='/api/content/drive-sync/status')return send(res,200,driveSync?driveSync.status():{enabled:false,authorized:false,error:driveSyncError,publicationSideEffects:false});
    if(req.method==='POST'&&url.pathname==='/api/content/drive-sync/run'){
      if(!driveSync)return send(res,503,{error:driveSyncError||'GOOGLE_DRIVE_SYNC_UNAVAILABLE'});
      try{return send(res,200,await driveSync.run('full'));}catch(error){return send(res,409,{error:String(error)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/workspace-context'){
      try{
        const context=await clientWorkspace(String(url.searchParams.get('workspace')||''));
        if(context.id==='ws-vietbridge'){
          const legacy=tasks.facebookAccounts.list().accounts.find(account=>account.id==='legacy-vietbridge');
          return send(res,200,{workspaceId:context.id,name:context.name,contentRoot:null,facebookPageId:legacy?.page_id||null,facebookPageName:legacy?.page_name||null,accountReady:Boolean(legacy)});
        }
        const account=context.account?.configUrl?tasks.facebookAccounts.importLocal(context.account.configUrl):undefined;
        return send(res,200,{workspaceId:context.id,name:context.name,contentRoot:context.contentRoot,facebookPageId:account?.page_id||null,facebookPageName:account?.page_name||context.account?.name||null,accountReady:Boolean(account?.page_id)});
      }catch(error){return send(res,400,{error:String(error)});}
    }
    if(req.method==='POST'&&url.pathname==='/api/workspace-context/activate'){
      try{
        const input=await readJson(req) as any,context=await clientWorkspace(String(input.workspace||''));
        if(context.id==='ws-vietbridge'){
          const legacy=tasks.facebookAccounts.get('legacy-vietbridge');
          tasks.facebookAccounts.select(legacy.id);
          return send(res,200,{workspaceId:context.id,name:context.name,contentRoot:null,facebookAccountId:legacy.id,facebookPageId:legacy.page_id});
        }
        if(!context.account?.configUrl)throw new Error('该客户尚未配置 Facebook 账号文件');
        const imported=tasks.facebookAccounts.importLocal(context.account.configUrl);
        if(!/^\d+$/.test(imported.page_id||''))throw new Error('客户配置缺少有效 Facebook Page ID');
        const existing=tasks.facebookAccounts.list().accounts.find(a=>a.page_id===imported.page_id&&a.config_url===context.account?.configUrl);
        const account=existing??tasks.facebookAccounts.save({display_name:context.account.name,page_id:imported.page_id,page_name:imported.page_name||context.account.name,config_url:context.account.configUrl});
        tasks.facebookAccounts.select(account.id);
        return send(res,200,{workspaceId:context.id,name:context.name,contentRoot:context.contentRoot,facebookAccountId:account.id,facebookPageId:account.page_id});
      }catch(error){return send(res,400,{error:String(error)});}
    }
    if(req.method==='POST'&&url.pathname==='/api/content/refresh-docx'){
      try {
        const articleId=String(url.searchParams.get('articleId')??'');
        const bytes=await readBinary(req,30_000_000);
        return send(res,200,localRefresh.refreshDocx(articleId,bytes));
      } catch(error) { return send(res,409,{error:String(error)}); }
    }
    if(req.method==='POST'&&url.pathname==='/api/content/refresh-image'){
      try {
        const articleId=String(url.searchParams.get('articleId')??'');
        const filename=String(req.headers['x-filename']??'');
        const qaConfirmed=req.headers['x-qa-confirmed']==='true';
        return send(res,200,localRefresh.refreshImage(articleId,filename,await readBinary(req,25_000_000),qaConfirmed));
      } catch(error) { return send(res,409,{error:String(error)}); }
    }
    if(req.method==='GET'&&url.pathname==='/api/content/candidates'){
      const requested=String(url.searchParams.get('platforms')??'').split(',').filter(Boolean);
      const platforms=requested.filter(value=>value in PLATFORM_CAPABILITIES) as (keyof typeof PLATFORM_CAPABILITIES)[];
      const candidates=tasks.candidates(platforms.length?platforms:undefined,url.searchParams.get('includePublished')==='1',url.searchParams.get('includeIncomplete')==='1');
      const workspace=String(url.searchParams.get('workspace')||'');
      if(!workspace){
        if(candidates.status==='CANDIDATES')candidates.candidates=candidates.candidates.filter(item=>!item.packageRoot.includes('/Content-Library/clients/'));
        return send(res,200,candidates);
      }
      try{
        const context=await clientWorkspace(workspace);
        if(candidates.status==='CANDIDATES')candidates.candidates=candidates.candidates.filter(item=>workspace==='ws-vietbridge'?!item.packageRoot.includes('/Content-Library/clients/'):item.packageRoot===context.contentRoot);
        return send(res,200,candidates);
      }catch(error){return send(res,400,{error:String(error)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/facebook/accounts'){const value=tasks.facebookAccounts.list();return send(res,200,{...value,accounts:value.accounts.map(account=>{let mode='API';try{if(browserPageConfig(account))mode='BROWSER'}catch{mode='CONFIG_ERROR'}return {...account,publishing_mode:mode}})});}
    if(req.method==='POST'&&url.pathname==='/api/facebook/accounts/import'){try{return send(res,200,tasks.facebookAccounts.importLocal(String((await readJson(req) as any).config_url||'')));}catch(error){return send(res,400,{error:String(error)});}}
    if(req.method==='POST'&&url.pathname==='/api/facebook/accounts'){try{return send(res,200,tasks.facebookAccounts.save(await readJson(req) as Record<string,unknown>));}catch(error){return send(res,400,{error:String(error)});}}
    if(req.method==='POST'&&url.pathname==='/api/facebook/accounts/select'){try{return send(res,200,tasks.facebookAccounts.select(String((await readJson(req) as any).id||'')));}catch(error){return send(res,400,{error:String(error)});}}
    if((req.method==='GET'||req.method==='HEAD')&&url.pathname==='/api/content/asset'){
      const path=String(url.searchParams.get('path')||'');
      const owner=tasks.library.resolve({mode:'local_path',value:path});
      const asset=owner.status==='MATCHED'?owner.package.assets.find(asset=>asset.path===path):undefined;
      if(!asset)return send(res,404,{error:'ASSET_NOT_FOUND'});
      const requestedRevision=String(url.searchParams.get('revision')||'');
      if(requestedRevision&&requestedRevision!==asset.revision)return send(res,409,{error:'ASSET_REVISION_CHANGED',revision:asset.revision});
      if(!existsSync(path))return send(res,404,{error:'ASSET_FILE_MISSING'});
      serveAsset(req,res,path,assetMime(path),asset.revision,Boolean(requestedRevision));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/content/preview'){
      try{
        const input=await readJson(req) as {articleId?:string;packageRoot?:string;version?:string};
        const item=tasks.library.index().find(candidate=>candidate.articleId===input.articleId&&(!input.packageRoot||candidate.packageRoot===input.packageRoot)&&(!input.version||candidate.version===input.version));
        if(!item)return send(res,404,{error:'CONTENT_PACKAGE_NOT_FOUND'});
        const payloads=Object.fromEntries(Object.entries(item.payloads).map(([platform,path])=>[platform,readFileSync(String(path),'utf8')]));
        const sourceTranscript=item.sourceEvidence.find(path=>path.endsWith(`${item.articleId}-source-full-text-internal.md`));
        const sourceTexts=sourceTranscript?{canonical_source_transcript:readFileSync(sourceTranscript,'utf8')}:{};
        const images=item.assets.filter(asset=>['cover','gallery_image','article_inline','video_cover'].includes(asset.role));
        const previewAssets=images.map(asset=>({role:asset.role,sequence:asset.sequence,ordinal:asset.ordinal,filename:asset.filename,staging_path:asset.path,mime_detected:/\.(png|jpe?g|webp)$/i.test(asset.filename)?'image/'+(asset.filename.toLowerCase().endsWith('.png')?'png':asset.filename.toLowerCase().endsWith('.webp')?'webp':'jpeg'):'application/octet-stream'}));
        const preparedPayloads={...payloads};
        let wechatPreviewError:string|undefined;
        if(payloads.wechat_official_account)try{preparedPayloads.wechat_official_account=prepareWechatDraftMarkdown(payloads.wechat_official_account,item.title,previewAssets);}catch(error){wechatPreviewError=String(error);}
        return send(res,200,{articleId:item.articleId,title:item.title,contentType:item.contentType,payloads:preparedPayloads,sourceTexts,previewSource:'CURRENT_LIBRARY_ASSEMBLED',wechatPreviewError,assets:images,videos:item.assets.filter(asset=>asset.role==='video')});
      }catch(error){return send(res,400,{error:String(error)});}
    }
    const frozenAsset=url.pathname.match(/^\/api\/jobs\/([^/]+)\/assets\/([^/]+)$/);
    if((req.method==='GET'||req.method==='HEAD')&&frozenAsset){
      const jobId=decodeURIComponent(frozenAsset[1]),assetId=decodeURIComponent(frozenAsset[2]);
      const row=db.prepare(`SELECT ca.staging_path,ca.mime_detected,ca.sha256 FROM content_assets ca
        JOIN publication_batches b ON b.content_snapshot_id=ca.snapshot_id JOIN jobs j ON j.batch_id=b.batch_id
        WHERE j.job_id=? AND ca.asset_id=?`).get(jobId,assetId) as {staging_path:string;mime_detected:string;sha256:string}|undefined;
      if(!row)return send(res,404,{error:'FROZEN_ASSET_NOT_FOUND'});
      if(!existsSync(row.staging_path))return send(res,404,{error:'FROZEN_ASSET_FILE_MISSING'});
      serveAsset(req,res,row.staging_path,assetMime(row.staging_path,row.mime_detected),row.sha256,true);return;
    }
    const frozenPreview=url.pathname.match(/^\/api\/jobs\/([^/]+)\/preview$/);
    if(req.method==='GET'&&frozenPreview){
      const jobId=decodeURIComponent(frozenPreview[1]);
      const row=db.prepare(`SELECT cs.canonical_payload_json,cs.snapshot_id,j.article_id FROM jobs j
        JOIN publication_batches b ON b.batch_id=j.batch_id JOIN content_snapshots cs ON cs.snapshot_id=b.content_snapshot_id
        WHERE j.job_id=?`).get(jobId) as {canonical_payload_json:string;snapshot_id:string;article_id:string}|undefined;
      if(!row)return send(res,404,{error:'JOB_PREVIEW_NOT_FOUND'});
      const assets=db.prepare(`SELECT asset_id,filename,role,ordinal,sequence,mime_detected,sha256,staging_path FROM content_assets
        WHERE snapshot_id=? AND mime_detected LIKE 'image/%' ORDER BY ordinal`).all(row.snapshot_id);
      const videos=(db.prepare(`SELECT asset_id,filename,role,ordinal,sequence,mime_detected,sha256,staging_path FROM content_assets
        WHERE snapshot_id=? AND mime_detected='video/mp4' ORDER BY ordinal`).all(row.snapshot_id) as Array<Record<string,any>>)
        .filter(asset=>existsSync(String(asset.staging_path)))
        .map(asset=>{const stat=statSync(String(asset.staging_path));return {...asset,...videoDetails(String(asset.staging_path),stat.size,stat.mtimeMs)};});
      const canonical=JSON.parse(row.canonical_payload_json);
      const preparedPayloads={...canonical.payloads};
      let wechatPreviewError:string|undefined;
      if(preparedPayloads?.wechat_official_account){
        const frozen=db.prepare(`SELECT role,ordinal,sequence,filename,staging_path,mime_detected FROM content_assets WHERE snapshot_id=? ORDER BY ordinal`).all(row.snapshot_id) as Record<string,unknown>[];
        try{preparedPayloads.wechat_official_account=prepareWechatDraftMarkdown(String(preparedPayloads.wechat_official_account),String(canonical.title||''),frozen);}catch(error){wechatPreviewError=String(error);}
      }
      return send(res,200,{articleId:row.article_id,...canonical,payloads:preparedPayloads,previewSource:'FROZEN_TASK_ASSEMBLED',wechatPreviewError,assets,videos});
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") return send(res, 200, { jobs: store.listJobs(Number(url.searchParams.get("limit") ?? 200)) });
    if(req.method==='GET'&&url.pathname==='/api/verification/wechat'){
      try{const inventory=await readWechatInventory(new WechatDraftReader()) as Record<string,any>;
        if(inventory.published_complete&&!inventory.published_error)inventory.reconciliation=ledgerReconciler.reconcileWechat(inventory.published,inventory.checked_at);
        return send(res,200,inventory);}
      catch(error){return send(res,503,{error:String(error)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/verification/wechat-browser/status')return send(res,200,await wechatBrowser.status());
    if(req.method==='POST'&&url.pathname==='/api/verification/wechat-browser/launch')return send(res,200,await wechatBrowser.launch());
    if(req.method==='POST'&&url.pathname==='/api/verification/wechat-browser/read')return send(res,200,await wechatBrowser.readVisibleInventory());
    if(req.method==='POST'&&url.pathname==='/api/verification/wechat-browser/reconcile'){
      const inventory=await wechatBrowser.readVisibleInventory();
      if(!inventory.status.loggedIn)return send(res,409,{error:'公众号后台尚未登录',...inventory});
      return send(res,200,{...inventory,reconciliation:ledgerReconciler.reconcileWechat(inventory.items,inventory.checked_at)});
    }
    if (req.method === "GET" && url.pathname === "/api/batches") {
      ledgerReconciler.syncVerifiedJobs();
      const workspace=String(url.searchParams.get('workspace')||'');
      const batches=tasks.listBatches();
      if(!workspace)return send(res,200,{batches:batches.filter(batch=>!(batch.jobs as Array<{article_id:string}>).some(job=>job.article_id.startsWith('CNVISA-')))});
      try{
        const context=await clientWorkspace(workspace);
        const ids=new Set(tasks.library.index().filter(item=>workspace==='ws-vietbridge'?!item.packageRoot.includes('/Content-Library/clients/'):item.packageRoot===context.contentRoot).map(item=>item.articleId));
        return send(res,200,{batches:batches.filter(batch=>(batch.jobs as Array<{article_id:string}>).some(job=>ids.has(job.article_id)))});
      }catch(error){return send(res,400,{error:String(error)});}
    }
    if(req.method==='POST' && url.pathname==='/api/history/clear') return send(res,200,tasks.clearHistory());
    if(req.method==='POST' && url.pathname==='/api/history/restore') {tasks.restoreHistory();return send(res,200,{restored:true});}
    if (req.method === "GET" && url.pathname === "/api/diagnostics/wechat-channels") {
      try { return send(res, 200, await worker.inspectWechatChannels()); }
      catch (error) { return send(res, 503, { error: String(error) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/services/xiaohongshu/start') {
      try { return send(res,200,await worker.ensureXiaohongshuReady()); }
      catch(error) { return send(res,503,{error:String(error)}); }
    }
    const draftReconcile=url.pathname.match(/^\/api\/jobs\/([^/]+)\/wechat-reconcile$/);
    if(req.method==='POST'&&draftReconcile){try{const jobId=decodeURIComponent(draftReconcile[1]),result=await worker.reconcileWechatDraft(jobId);ledgerReconciler.syncVerifiedJob(jobId);return send(res,200,result);}catch(error){return send(res,409,{error:String(error)});}}
    const draftDelete=url.pathname.match(/^\/api\/jobs\/([^/]+)\/wechat-delete$/);
    if(req.method==='POST'&&draftDelete){try{return send(res,200,await worker.deleteWechatDraft(decodeURIComponent(draftDelete[1])));}catch(error){return send(res,409,{error:String(error)});}}
    const manualDraftDelete=url.pathname.match(/^\/api\/jobs\/([^/]+)\/wechat-manual-deleted$/);
    if(req.method==='POST'&&manualDraftDelete){try{return send(res,200,tasks.confirmWechatDraftDeleted(decodeURIComponent(manualDraftDelete[1])));}catch(error){return send(res,409,{error:String(error)});}}
    const stop = url.pathname.match(/^\/api\/batches\/([^/]+)\/stop$/);
    if (req.method === 'POST' && stop) {
      try { return send(res,200,tasks.stopBatch(decodeURIComponent(stop[1]))); }
      catch(error) { return send(res,409,{error:String(error)}); }
    }
    if (req.method === "POST" && url.pathname === "/api/content/resolve") {
      try {
        const input=await readJson(req) as ExecuteTaskInput & {workspace?:string};
        const result=tasks.preview(input);
        const context=input.workspace?await clientWorkspace(input.workspace):null;
        const allowed=(root:string)=>context?(input.workspace==='ws-vietbridge'?!root.includes('/Content-Library/clients/'):root===context.contentRoot):!root.includes('/Content-Library/clients/');
        if(result.status==='MATCHED'&&!allowed(result.package.packageRoot))return send(res,200,{status:'REJECTED',reason:'内容不属于当前客户'});
        if(result.status==='CANDIDATES')result.candidates=result.candidates.filter(item=>allowed(item.packageRoot));
        return send(res,200,result);
      }
      catch (error) { return send(res, 400, { error: String(error) }); }
    }
    if (req.method === "POST" && url.pathname === "/api/content/match-file") {
      try {
        const data = await readBinary(req, 250_000_000);
        const platforms = String(req.headers["x-platforms"] ?? "").split(",").filter(Boolean) as any;
        return send(res, 200, tasks.library.resolveBytes(data, platforms));
      } catch (error) { return send(res, 400, { error: String(error) }); }
    }
    if (req.method === "POST" && url.pathname === "/api/tasks/execute") {
      try {
        const input=await readJson(req) as ExecuteTaskInput & {workspace?:string};
        if(!input.workspace&&input.selectedPackageRoot?.includes('/Content-Library/clients/'))throw new Error('客户内容必须从对应客户入口打开');
        if(!input.workspace){
          const candidate=tasks.library.index().find(item=>item.articleId===(input.selectedArticleId||input.value));
          if(candidate?.packageRoot.includes('/Content-Library/clients/'))throw new Error('客户内容必须从对应客户入口打开');
        }
        if(input.workspace){
          const context=await clientWorkspace(input.workspace);
          if(!input.selectedPackageRoot||!input.selectedArticleId)throw new Error('请先从当前客户资源库选定内容');
          if(input.workspace==='ws-vietbridge'?input.selectedPackageRoot.includes('/Content-Library/clients/'):input.selectedPackageRoot!==context.contentRoot)throw new Error('所选内容不属于当前客户');
          if(input.platforms?.includes('facebook')){
            if(input.workspace==='ws-vietbridge'){
              if(input.facebookAccountId!=='legacy-vietbridge')throw new Error('Facebook 账号与 VietBridge 客户不一致');
            }else{
            const imported=context.account?.configUrl?tasks.facebookAccounts.importLocal(context.account.configUrl):undefined;
            const chosen=input.facebookAccountId?tasks.facebookAccounts.get(input.facebookAccountId):undefined;
            if(!imported?.page_id||!chosen||chosen.page_id!==imported.page_id||chosen.config_url!==context.account?.configUrl)throw new Error('Facebook 账号与当前客户不一致，请重新打开客户发布器');
            }
          }
        }
        const result = tasks.execute(input);
        return send(res, "batch_id" in result ? 201 : 409, result);
      } catch (error) { return send(res, 400, { error: String(error) }); }
    }
    const commandMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/(approve|pause-or-terminate|resume)$/);
    if (req.method === "POST" && commandMatch) {
      try {
        const id = decodeURIComponent(commandMatch[1]);
        const command = commandMatch[2];
        return send(res, 200, command === "approve" ? tasks.approve(id) : command === "resume" ? tasks.resume(id) : tasks.pauseOrTerminate(id));
      }
      catch (error) { return send(res, 409, { error: String(error) }); }
    }
    const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && match) {
      try {
        const jobId = decodeURIComponent(match[1]);
        return send(res, 200, { job: store.getJob(jobId), history: store.jobHistory(jobId), formSnapshot: store.latestFormSnapshot(jobId) });
      } catch (error) { return send(res, 404, { error: String(error) }); }
    }
    const retry = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    const reconcile = url.pathname.match(/^\/api\/jobs\/([^/]+)\/reconcile$/);
    if(req.method==='POST'&&reconcile){try{const id=decodeURIComponent(reconcile[1]),platform=store.getJob(id).platform,result=await (platform==='wechat_channels'?worker.reconcileWechatChannels(id):platform==='facebook'?worker.reconcileFacebook(id):worker.reconcileXiaohongshu(id));ledgerReconciler.syncVerifiedJob(id);return send(res,200,result);}catch(error){return send(res,409,{error:String(error)});}}
    if (req.method === 'POST' && retry) {
      try { return send(res, 200, tasks.retryFailed(decodeURIComponent(retry[1]))); }
      catch (error) { return send(res, 409, {error: String(error)}); }
    }
    const loginRetry = url.pathname.match(/^\/api\/jobs\/([^/]+)\/login-complete$/);
    if (req.method === "POST" && loginRetry) {
      try { return send(res, 200, tasks.retryLoginPreflight(decodeURIComponent(loginRetry[1]))); }
      catch (error) { return send(res, 409, { error: String(error) }); }
    }
    return send(res, req.method === "GET" ? 404 : 405, { error: req.method === "GET" ? "NOT_FOUND" : "METHOD_NOT_ALLOWED" });
  });
  server.on("close", () => { driveSync?.stop(); void worker.stop().finally(() => db.close()); });
  return server;
}

async function readWechatInventory(reader:WechatDraftReader):Promise<unknown>{
  const collect=async(kind:'draft'|'published')=>{const items:any[]=[];let complete=false;for(let offset=0;offset<500;offset+=20){const page=kind==='draft'?await reader.list(offset):await reader.publishedList(offset),rows=Array.isArray(page.item)?page.item:[];for(const row of rows){const article=Array.isArray(row.content?.news_item)?row.content.news_item[0]:undefined;items.push({id:String(row.media_id||row.article_id||''),title:String(article?.title||''),url:String(article?.url||''),updated_at:row.update_time?new Date(Number(row.update_time)*1000).toISOString():null,channel:kind});}if(offset+Number(page.item_count??rows.length)>=Number(page.total_count??0)){complete=true;break;}}return {items,complete};};
  const analytics=async()=>{const items:any[]=[];let lastError:string|null=null;for(let days=1;days<=7;days++){const day=new Date(Date.now()-days*86400000).toISOString().slice(0,10);try{const [summary,total]=await Promise.all([reader.articleSummary(day),reader.articleTotal(day)]);const totals=new Map((total.list||[]).map((x:any)=>[String(x.msgid||''),x]));for(const row of summary.list||[]){const detail:any=totals.get(String(row.msgid||''));items.push({msgid:String(row.msgid||''),title:String(row.title||''),ref_date:String(row.ref_date||day),read_users:Number(row.int_page_read_user||0),read_count:Number(row.int_page_read_count||0),share_users:Number(row.share_user||0),share_count:Number(row.share_count||0),detail_points:Array.isArray(detail?.details)?detail.details.length:0,channel:'content_analytics'});}}catch(error){lastError=String(error);break;}}return {items,error:lastError};};
  const [publishedResult,draftsResult,analyticsResult]=await Promise.allSettled([collect('published'),collect('draft'),analytics()]),published=publishedResult.status==='fulfilled'?publishedResult.value:{items:[],complete:false},drafts=draftsResult.status==='fulfilled'?draftsResult.value:{items:[],complete:false},contentData=analyticsResult.status==='fulfilled'?analyticsResult.value:{items:[],error:String(analyticsResult.reason)};return {platform:'wechat_official_account',published:published.items,drafts:drafts.items,content_data:contentData.items,published_complete:published.complete,drafts_complete:drafts.complete,published_error:publishedResult.status==='rejected'?String(publishedResult.reason):null,drafts_error:draftsResult.status==='rejected'?String(draftsResult.reason):null,content_data_error:contentData.error,checked_at:new Date().toISOString()};
}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new Error("application/json required");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request too large");
  }
  return JSON.parse(body || "{}");
}

async function readBinary(req: import("node:http").IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk); size += data.length;
    if (size > limit) throw new Error("文件过大");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

export async function startPublisherServer(options: WebServerOptions = {}): Promise<Server> {
  const server = createPublisherServer(options);
  const host = options.host ?? process.env.PUBLISHER_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PUBLISHER_PORT ?? 17880);
  await new Promise<void>((resolveListen, reject) => server.listen(port, host, resolveListen).once("error", reject));
  return server;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
  res.end(body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startPublisherServer();
  const address = server.address();
  console.log(`VietBridge Publisher: http://127.0.0.1:${typeof address === "object" && address ? address.port : 17880}`);
}
