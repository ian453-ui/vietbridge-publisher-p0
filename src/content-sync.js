import {readFileSync,realpathSync,existsSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ManifestDriveSync} from './publisher-core/manifest-drive-sync.ts';

/** Registered V1 sources only. Never derives an account/workspace binding from names. */
export class ContentSync {
  constructor(store,library,{sources=[],makeClient,automatic=false}={}){this.store=store;this.library=library;this.sources=sources;this.makeClient=makeClient;this.automatic=automatic;this.workers=new Map();this.inflight=new Map();this.errors=new Map();this.activeAccounts=new Map();}
  binding(workspace,accountId){
    this.store.requireWorkspace(workspace);const account=this.store.account(workspace,accountId);if(!account.enabled)throw Error('CONTENT_SYNC_ACCOUNT_DISABLED');
    const matches=this.sources.filter(s=>s.workspaceId===workspace);if(matches.length!==1)throw Error('CONTENT_SYNC_EXACT_SOURCE_REQUIRED');
    const source=matches[0];if(this.sources.filter(s=>s.relativeRoot===source.relativeRoot).length!==1)throw Error('CONTENT_SYNC_EXACT_SOURCE_REQUIRED');const root=resolve(this.library.roots[0],source.relativeRoot||'');
    if(!source.relativeRoot?.match(/^clients\/[a-z0-9-]+$/)||!existsSync(root)||realpathSync(root)!==this.library.clientRoot(workspace))throw Error('CONTENT_SYNC_SOURCE_ROOT_MISMATCH');
    const owners=this.store.list('workspaces').filter(w=>w.content_root&&existsSync(w.content_root)&&realpathSync(w.content_root)===realpathSync(root));if(owners.length!==1||owners[0].id!==workspace)throw Error('CONTENT_SYNC_SOURCE_ROOT_MISMATCH');
    return source;
  }
  status(workspace,accountId){try{this.binding(workspace,accountId);return {...this.workers.get(workspace)?.status(),workspace,accountId,enabled:Boolean(this.makeClient),automatic:Boolean(this.timer),running:this.inflight.has(workspace),error:this.errors.get(workspace)||'',publicationSideEffects:false,manualPermission:this.manualPermission?.(workspace,accountId)||{canRun:Boolean(this.makeClient)}};}catch(e){const error=this.errors.get(workspace)||e.message;return {...this.workers.get(workspace)?.status(),workspace,accountId,enabled:false,automatic:false,running:this.inflight.has(workspace),error,publicationSideEffects:false,manualPermission:{canRun:false,reason:error}};}}
  run(workspace,accountId){const source=this.binding(workspace,accountId);if(!this.makeClient)throw Error('CONTENT_SYNC_CONNECTOR_NOT_CONFIGURED');if(this.inflight.has(workspace))return this.inflight.get(workspace);
    this.activeAccounts.set(workspace,accountId);
    const pending=(async()=>{try{let worker=this.workers.get(workspace);if(!worker){const client=await this.makeClient();if(typeof client?.downloadRaw!=='function')throw Error('CONTENT_SYNC_RAW_DOWNLOAD_REQUIRED');worker=new ManifestDriveSync(client,this.library.roots[0],[source],()=>{this.beforeRead?.();try{if(this.binding(workspace,this.activeAccounts.get(workspace))!==source)throw Error('changed');}catch{throw Error('MANIFEST_SOURCE_BINDING_CHANGED');}});this.workers.set(workspace,worker);}this.binding(workspace,accountId);await worker.run();this.library.cache.delete(workspace);this.errors.delete(workspace);return {...this.status(workspace,accountId),running:false};}catch(e){const error=/^(?:MANIFEST|MANUAL_SYNC|CONTENT_SYNC|GOOGLE_DRIVE|GOOGLE_TOKEN)_[A-Z0-9_]+$/.test(e.message)?e.message:'CONTENT_SYNC_FAILED';this.errors.set(workspace,error);throw Error(error);}})().finally(()=>{this.inflight.delete(workspace);this.activeAccounts.delete(workspace);});this.inflight.set(workspace,pending);return pending;
  }
  tick(){if(this.stopped)return Promise.resolve();if(this.ticking)return this.ticking;this.ticking=Promise.allSettled(this.sources.map(source=>{const account=this.store.db.prepare('SELECT id FROM facebook_accounts WHERE workspace=? AND enabled=1 ORDER BY rowid LIMIT 1').get(source.workspaceId);return account?Promise.resolve().then(()=>this.stopped?undefined:this.run(source.workspaceId,account.id)):Promise.resolve();})).finally(()=>{this.ticking=null;});return this.ticking;}
  start(){if(!this.automatic||this.timer)return;this.stopped=false;void this.tick();this.timer=setInterval(()=>void this.tick(),120000);this.timer.unref();}
  async stop(){this.stopped=true;clearInterval(this.timer);this.timer=null;await Promise.allSettled([this.ticking,...this.inflight.values()]);}
}

/** Existing V1 makeClient is reused lazily; this function never reads credentials. */
export function contentSyncOptions(env=process.env){
  const registration=env.PUBLISHER_MANIFEST_SOURCES_FILE,entry=env.PUBLISHER_DRIVE_CONNECTOR_ENTRY;
  if(!registration&&!entry)return {};
  if(!isAbsolute(registration||'')||!isAbsolute(entry||''))throw Error('CONTENT_SYNC_ABSOLUTE_REGISTRATION_AND_CONNECTOR_REQUIRED');
  const sources=JSON.parse(readFileSync(registration,'utf8'));if(!Array.isArray(sources)||sources.some(s=>!s||typeof s.projectId!=='string'||!s.projectId.match(/^[A-Z0-9-]+$/)||typeof s.workspaceId!=='string'||!s.workspaceId.match(/^ws-[a-z0-9-]+$/i)||typeof s.relativeRoot!=='string'||!s.relativeRoot.match(/^clients\/[a-z0-9-]+$/)||typeof s.manifestDriveFileId!=='string'||!s.manifestDriveFileId))throw Error('CONTENT_SYNC_REGISTRATION_INVALID');
  if(new Set(sources.map(s=>s.workspaceId)).size!==sources.length||new Set(sources.map(s=>s.relativeRoot)).size!==sources.length)throw Error('CONTENT_SYNC_EXACT_SOURCE_REQUIRED');
  const connector=pathToFileURL(realpathSync(entry)).href;
  return {sources,automatic:env.PUBLISHER_ENABLE_CONTENT_SYNC==='1',makeClient:async()=>{const {GoogleDriveCanonicalSync}=await import(connector);if(!GoogleDriveCanonicalSync?.makeClient)throw Error('CONTENT_SYNC_EXISTING_CONNECTOR_REQUIRED');return GoogleDriveCanonicalSync.makeClient();}};
}
