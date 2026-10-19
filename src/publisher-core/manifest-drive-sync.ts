// Adapted from Publisher-P0/src/manifest-drive-sync.ts: same registered source and
// downloadRaw contract. Local immutable files + one manifest switch prevent half updates.
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {dirname,resolve,sep,extname,relative} from 'node:path';
export type ManifestSource={projectId:string;workspaceId:string;manifestDriveFileId:string;relativeRoot:string};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function ensureInsideDirectory(root:string,directory:string){let current=realpathSync(root);for(const part of relative(root,directory).split(sep).filter(Boolean)){if(part==='..')throw Error('MANIFEST_PATH_ESCAPE');current=resolve(current,part);if(existsSync(current)){if(!realpathSync(current).startsWith(realpathSync(root)+sep))throw Error('MANIFEST_PATH_ESCAPE');}else mkdirSync(current);}}
// Authentication and source authority failures abort the whole run. Item-level
// missing files, content errors and hashes remain independently isolated.
const fatalCode=(error:unknown)=>{
  const value=error instanceof Error?error.message:'';
  if(error instanceof SyntaxError)return 'GOOGLE_DRIVE_READ_RESPONSE_INVALID';
  if(error instanceof Error&&(['AbortError','TimeoutError'].includes(error.name)||error instanceof TypeError&&value==='fetch failed'))return 'GOOGLE_DRIVE_READ_TRANSPORT_FAILED';
  return /^(?:MANUAL_SYNC_[A-Z0-9_]+|MANIFEST_SOURCE_(?:BINDING_CHANGED|REGISTRATION_INVALID|OUTSIDE_CLIENT_ROOT|IDENTITY_MISMATCH)|GOOGLE_DRIVE_(?:NOT_AUTHORIZED|AUTH_EXPIRED|ACCESS_TOKEN_MISSING|READ_TRANSPORT_FAILED|READ_RESPONSE_INVALID)|GOOGLE_TOKEN_HTTP_[1-5][0-9]{2}|GOOGLE_DRIVE_(?:DOWNLOAD|API|EXPORT)_HTTP_(?:401|403))$/.test(value)?value:'';
};
const code=(error:unknown)=>String(error instanceof Error?error.message:error).match(/^MANIFEST_[A-Z_]+(?::[-A-Z0-9]{5,80})?$/)?.[0]||'MANIFEST_DOWNLOAD_FAILED';
export class ManifestDriveSync {
  private timer?:NodeJS.Timeout;
  private running?:Promise<unknown>;
  private lastCompletedAt:string|null=null;
  private lastResult:unknown=null;
  private lastError='';
  private drive:{downloadRaw(id:string):Promise<Buffer>};
  private contentRoot:string;
  private sources:ManifestSource[];
  private assertScope:()=>void;
  constructor(drive:{downloadRaw(id:string):Promise<Buffer>},contentRoot:string,sources:ManifestSource[],assertScope:()=>void=()=>{}){this.drive=drive;this.contentRoot=contentRoot;this.sources=sources;this.assertScope=assertScope;}
  start(){if(this.timer)return;void this.run().catch(()=>{});this.timer=setInterval(()=>void this.run().catch(()=>{}),120_000);this.timer.unref();}
  stop(){clearInterval(this.timer);this.timer=undefined;return this.running;}
  status(){return {enabled:true,automatic:Boolean(this.timer),running:Boolean(this.running),lastCompletedAt:this.lastCompletedAt,lastResult:this.lastResult,lastError:this.lastError,publicationSideEffects:false};}
  run(){if(this.running)return this.running;this.running=this.syncAll().then(result=>{this.lastCompletedAt=new Date().toISOString();this.lastResult=result;this.lastError='';return result;}).catch(e=>{this.lastError=fatalCode(e)||code(e);throw Error(this.lastError);}).finally(()=>{this.running=undefined;});return this.running;}
  private async syncAll(){const result=[];for(const source of this.sources){try{result.push(await this.syncOne(source));}catch(e){if(fatalCode(e))throw e;result.push({workspaceId:source.workspaceId,projectId:source.projectId,error:code(e)});}}return result;}
  private async syncOne(source:ManifestSource){
    if(!/^[A-Z0-9-]+$/.test(source.projectId)||!/^ws-[a-z0-9-]+$/i.test(source.workspaceId)||!/^clients\/[a-z0-9-]+$/.test(source.relativeRoot)||!source.manifestDriveFileId)throw Error('MANIFEST_SOURCE_REGISTRATION_INVALID');
    const base=realpathSync(this.contentRoot),root=resolve(base,source.relativeRoot);
    if(!existsSync(root)||!realpathSync(resolve(base,'clients')).startsWith(base+sep)||!realpathSync(root).startsWith(realpathSync(resolve(base,'clients'))+sep))throw Error('MANIFEST_SOURCE_OUTSIDE_CLIENT_ROOT');
    this.assertScope();
    const raw=await this.drive.downloadRaw(source.manifestDriveFileId);
    this.assertScope();
    if(raw.length>5_000_000)throw Error('MANIFEST_TOO_LARGE');
    let manifest:any;try{manifest=JSON.parse(raw.toString('utf8'));}catch{throw Error('MANIFEST_FORMAT_INVALID');}
    if(manifest.project_id!==source.projectId||manifest.workspace!=='independent-client'||!Array.isArray(manifest.items)||manifest.items.length>1000)throw Error('MANIFEST_SOURCE_IDENTITY_MISMATCH');
    const counts=new Map<string,number>();for(const item of manifest.items){const id=String(item?.content_id||'');counts.set(id,(counts.get(id)||0)+1);}
    const errors:Array<{contentId:string;error:string}>=[];let updated=0;
    const items=[];
    for(const entry of manifest.items){const item={...entry},id=String(item.content_id||'');
      try{
        if(!/^[-A-Z0-9]{5,80}$/.test(id)||counts.get(id)!==1)throw Error('MANIFEST_CONTENT_ID_INVALID');
        const specs=[[item.body_source,item.content_drive_file_id,undefined,'content'],[item.primary_image,item.primary_image_drive_file_id,item.primary_image_sha256,'assets']] as const;
        const files=[];
        for(const [path,driveId,expectedHash,kind] of specs){
          if(typeof path!=='string'||typeof driveId!=='string'||!driveId||!new RegExp('^READY/'+kind+'/[A-Za-z0-9_.-]+$').test(path)||!path.includes(id))throw Error('MANIFEST_FILE_BINDING_INVALID');
          this.assertScope();const bytes=await this.drive.downloadRaw(driveId);this.assertScope();if(!bytes.length||bytes.length>30_000_000)throw Error('MANIFEST_FILE_SIZE_INVALID');
          const hash=sha(bytes);if(expectedHash&&hash!==expectedHash)throw Error('MANIFEST_ASSET_HASH_MISMATCH');
          const extension=extname(path).toLowerCase();if(kind==='content'&&extension!=='.md'||kind==='assets'&&!['.png','.jpg','.jpeg','.webp'].includes(extension))throw Error('MANIFEST_FILE_BINDING_INVALID');
          files.push({bytes,hash,path:`READY/${kind}/${id}-${hash}${extension}`});
        }
        // No file is touched until both downloads and checks succeeded. Files are
        // immutable; the final atomic manifest rename is the visibility boundary.
        for(const file of files){this.assertScope();const target=resolve(root,file.path);ensureInsideDirectory(root,dirname(target));if(existsSync(target)&&!realpathSync(target).startsWith(realpathSync(root)+sep))throw Error('MANIFEST_PATH_ESCAPE');
          if(existsSync(target)){if(sha(readFileSync(target))!==file.hash)throw Error('MANIFEST_ASSET_HASH_MISMATCH');continue;}
          const temporary=target+'.publisher-download-'+randomUUID();try{writeFileSync(temporary,file.bytes,{flag:'wx'});renameSync(temporary,target);}finally{if(existsSync(temporary))rmSync(temporary);}updated++;
        }
        item.body_source=files[0].path;item.primary_image=files[1].path;item.primary_image_sha256=files[1].hash;delete item.sync_error;
      }catch(e){if(fatalCode(e))throw e;item.status='BLOCKED';item.sync_error=code(e);errors.push({contentId:/^[-A-Z0-9]{5,80}$/.test(id)?id:'INVALID',error:item.sync_error});}
      items.push(item);
    }
    this.assertScope();
    const local=Buffer.from(JSON.stringify({...manifest,items}));const target=resolve(root,'publisher-manifest.json');
    if(existsSync(target)&&!realpathSync(target).startsWith(realpathSync(root)+sep))throw Error('MANIFEST_PATH_ESCAPE');
    if(!existsSync(target)||!readFileSync(target).equals(local)){const temporary=target+'.publisher-download-'+randomUUID();try{writeFileSync(temporary,local,{flag:'wx'});renameSync(temporary,target);}finally{if(existsSync(temporary))rmSync(temporary);}updated++;}
    return {workspaceId:source.workspaceId,projectId:source.projectId,revision:manifest.manifest_revision,items:items.length,updated,errors};
  }
}
