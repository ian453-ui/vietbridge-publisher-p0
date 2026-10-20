import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';

export type ManifestSource={projectId:string;workspaceId:string;manifestDriveFileId:string;relativeRoot:string};
type Entry={content_id:string;body_source:string;content_drive_file_id:string;primary_image:string;primary_image_drive_file_id:string;primary_image_sha256?:string};

// Registered client sources are intentionally separate from the VietBridge Docs pipeline.
export class ManifestDriveSync {
  private readonly drive:{downloadRaw(id:string):Promise<Buffer>};
  private readonly contentRoot:string;
  private readonly sources:ManifestSource[];
  private timer?:NodeJS.Timeout;
  private running?:Promise<unknown>;
  private lastError='';
  private lastCompletedAt:string|null=null;
  private lastResult:unknown=null;
  constructor(drive:{downloadRaw(id:string):Promise<Buffer>},contentRoot:string,sources:ManifestSource[]){this.drive=drive;this.contentRoot=contentRoot;this.sources=sources;}
  start(){if(this.timer)return;void this.run().catch(()=>{});this.timer=setInterval(()=>{void this.run().catch(()=>{});},120_000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  status(){return {enabled:true,automatic:Boolean(this.timer),running:Boolean(this.running),authorized:true,lastError:this.lastError,lastCompletedAt:this.lastCompletedAt,lastResult:this.lastResult,sources:this.sources.map(({projectId,workspaceId,relativeRoot})=>({projectId,workspaceId,relativeRoot})),publicationSideEffects:false};}
  run(){if(this.running)return this.running;this.running=this.syncAll().then(result=>{this.lastError='';this.lastCompletedAt=new Date().toISOString();this.lastResult=result;return result;}).catch(error=>{this.lastError=String(error);throw error;}).finally(()=>{this.running=undefined;});return this.running;}
  private async syncAll(){const result=[];for(const source of this.sources)result.push(await this.syncOne(source));return result;}
  private async syncOne(source:ManifestSource){
    if(!/^[A-Z0-9-]+$/.test(source.projectId)||!/^ws-[a-z0-9-]+$/i.test(source.workspaceId)||!/^clients\/[a-z0-9-]+$/.test(source.relativeRoot))throw new Error('MANIFEST_SOURCE_REGISTRATION_INVALID');
    const root=resolve(this.contentRoot,source.relativeRoot);
    if(!root.startsWith(resolve(this.contentRoot,'clients')+sep))throw new Error('MANIFEST_SOURCE_OUTSIDE_CLIENT_ROOT');
    const raw=await this.drive.downloadRaw(source.manifestDriveFileId);
    const manifest=JSON.parse(raw.toString('utf8')) as {project_id?:string;workspace?:string;status?:string;manifest_revision?:number;items?:Entry[]};
    if(manifest.project_id!==source.projectId||manifest.workspace!=='independent-client'||!Array.isArray(manifest.items))throw new Error('MANIFEST_SOURCE_IDENTITY_MISMATCH');
    const seen=new Set<string>();let updated=0;
    for(const item of manifest.items){
      if(!/^[-A-Z0-9]{5,80}$/.test(item.content_id)||seen.has(item.content_id))throw new Error('MANIFEST_CONTENT_ID_INVALID');seen.add(item.content_id);
      for(const [path,id,expectedHash] of [[item.body_source,item.content_drive_file_id,undefined],[item.primary_image,item.primary_image_drive_file_id,item.primary_image_sha256]] as const){
        if(!path||!id||!/^READY\/(?:content|assets)\/[A-Za-z0-9_.-]+$/.test(path)||!path.includes(item.content_id))throw new Error(`MANIFEST_FILE_BINDING_INVALID:${item.content_id}`);
        const target=resolve(root,path);if(!target.startsWith(root+sep))throw new Error('MANIFEST_PATH_ESCAPE');
        const bytes=await this.drive.downloadRaw(id),hash=createHash('sha256').update(bytes).digest('hex');
        if(expectedHash&&hash!==expectedHash)throw new Error(`MANIFEST_ASSET_HASH_MISMATCH:${item.content_id}`);
        if(existsSync(target)&&createHash('sha256').update(readFileSync(target)).digest('hex')===hash)continue;
        mkdirSync(dirname(target),{recursive:true});const temporary=target+'.publisher-download';
        try{writeFileSync(temporary,bytes,{flag:'w'});renameSync(temporary,target);}finally{if(existsSync(temporary))rmSync(temporary);}
        updated++;
      }
    }
    mkdirSync(root,{recursive:true});const target=resolve(root,'publisher-manifest.json');
    if(!existsSync(target)||!readFileSync(target).equals(raw)){const temporary=target+'.publisher-download';try{writeFileSync(temporary,raw,{flag:'w'});renameSync(temporary,target);}finally{if(existsSync(temporary))rmSync(temporary);}updated++;}
    return {projectId:source.projectId,workspaceId:source.workspaceId,revision:manifest.manifest_revision,items:seen.size,updated,root};
  }
}
