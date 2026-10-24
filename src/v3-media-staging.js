import {createHash,randomUUID} from 'node:crypto';
import {open,mkdir,link,unlink,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {isAbsolute,join} from 'node:path';

const types={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4'};
const validSignature=(mime,header)=>mime==='image/png'?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?header[0]===255&&header[1]===216&&header[2]===255:mime==='image/webp'?header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP':header.toString('ascii',4,8)==='ftyp';
const fail=code=>{throw Error(code);};
const validManifest=({root,siteJobId,ordinal,mime,sha256,size})=>isAbsolute(root||'')&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(siteJobId||'')&&Number.isInteger(ordinal)&&ordinal>=0&&ordinal<=9&&Object.hasOwn(types,mime)&&/^[a-f0-9]{64}$/.test(sha256||'')&&Number.isSafeInteger(size)&&size>=1&&size<=(mime==='video/mp4'?150_000_000:25_000_000);

export async function verifyV3StagedMedia(manifest){
 if(!validManifest(manifest))fail('V3_MEDIA_MANIFEST_INVALID');
 const {root,siteJobId,ordinal,mime,sha256,size}=manifest,dir=join(root,siteJobId),target=join(dir,String(ordinal)+types[mime]);
 let dirStat,stat;try{dirStat=await lstat(dir);stat=await lstat(target);}catch(error){if(error.code==='ENOENT')fail('V3_MEDIA_NOT_STAGED');throw error;}
 if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||(dirStat.mode&0o077)!==0||!stat.isFile()||stat.isSymbolicLink()||stat.size!==size)fail('V3_MEDIA_CONFLICT');
 const digest=createHash('sha256');let header=Buffer.alloc(0);for await(const chunk of createReadStream(target)){digest.update(chunk);if(header.length<12)header=Buffer.concat([header,chunk.subarray(0,12-header.length)]);}
 if(digest.digest('hex')!==sha256||!validSignature(mime,header))fail('V3_MEDIA_CONFLICT');return target;
}

/** Stages bytes from a server-authorized Sites object. This never imports,
 * approves or publishes them; the eventual local job must independently bind
 * the complete approved manifest and freeze the same SHA-256 bytes.
 */
export async function stageV3Media({root,siteJobId,ordinal,mime,sha256,size,stream}){
 if(!validManifest({root,siteJobId,ordinal,mime,sha256,size})||!stream?.[Symbol.asyncIterator])fail('V3_MEDIA_MANIFEST_INVALID');
 const dir=join(root,siteJobId),target=join(dir,String(ordinal)+types[mime]);await mkdir(dir,{recursive:true,mode:0o700});const dirStat=await lstat(dir);if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||(dirStat.mode&0o077)!==0)fail('V3_MEDIA_DIRECTORY_UNSAFE');
 const existing=async()=>{try{const path=await verifyV3StagedMedia({root,siteJobId,ordinal,mime,sha256,size});return {site_job_id:siteJobId,ordinal,mime,sha256,size,path,duplicate:true};}catch(error){if(error.message==='V3_MEDIA_NOT_STAGED')return null;throw error;}};
 const prior=await existing();if(prior)return prior;
 const temp=join(dir,'.'+randomUUID()+'.tmp'),file=await open(temp,'wx',0o600),hash=createHash('sha256');let count=0,header=Buffer.alloc(0);
 try{
  for await(const value of stream){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);count+=chunk.length;if(count>size)fail('V3_MEDIA_SIZE_MISMATCH');hash.update(chunk);if(header.length<12)header=Buffer.concat([header,chunk.subarray(0,12-header.length)]);let offset=0;while(offset<chunk.length){const written=await file.write(chunk,offset,chunk.length-offset);if(written.bytesWritten<=0)fail('V3_MEDIA_WRITE_FAILED');offset+=written.bytesWritten;}}
  if(count!==size||hash.digest('hex')!==sha256||!validSignature(mime,header))fail('V3_MEDIA_HASH_OR_FORMAT_MISMATCH');
  await file.sync();await file.close();
  try{await link(temp,target);}catch(error){if(error.code!=='EEXIST')throw error;const winner=await existing();if(!winner)throw error;return winner;}
  return {site_job_id:siteJobId,ordinal,mime,sha256,size,path:target,duplicate:false};
 }finally{await file.close().catch(()=>{});await unlink(temp).catch(()=>{});}
}
