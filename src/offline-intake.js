import {openSync,closeSync,fstatSync,readSync,realpathSync,constants} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {ArchiveAssetResolver} from './archive-asset-resolver.js';
import {ingestArchiveProduction} from './archive-production-intake.js';
import {ProductionReviewStore} from './production-review-store.js';
import {MetricObservationStore} from './metric-observation-store.js';

const fail=code=>{throw Error(code);};
const exact=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail('OFFLINE_MANIFEST_INVALID');};
/** Local bounded regular-file snapshots. Root must be private to its trusted local owner. */
export function readOfflineFile(root,path,max){
 if(typeof path!=='string'||!path||isAbsolute(path)||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))fail('OFFLINE_PATH_INVALID');
 const base=realpathSync(root),file=realpathSync(resolve(base,path)),rel=relative(base,file);
 if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))fail('OFFLINE_PATH_ESCAPE');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>max)fail('OFFLINE_SIZE_LIMIT');const data=Buffer.alloc(stat.size);let offset=0;while(offset<data.length){const n=readSync(fd,data,offset,data.length-offset,null);if(!n)fail('OFFLINE_FILE_CHANGED');offset+=n;}if(readSync(fd,Buffer.alloc(1),0,1,null))fail('OFFLINE_FILE_CHANGED');return data;}finally{closeSync(fd);}
}
export const readOfflineJson=(root,path)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readOfflineFile(root,path,1024*1024)));

export async function importOfflineArchive(db,{root,manifestPath='offline-archive.json',cacheRoot}){
 const packet=readOfflineJson(root,manifestPath);exact(packet,['schema_version','kind','request','archive_manifest','parts']);
 if(packet.schema_version!==1||packet.kind!=='ARCHIVE_PRODUCTION'||!Array.isArray(packet.parts)||packet.parts.length>3200)fail('OFFLINE_MANIFEST_INVALID');
 const paths=new Map();for(const p of packet.parts){exact(p,['file_id','path']);if(typeof p.file_id!=='string'||paths.has(p.file_id)||typeof p.path!=='string')fail('OFFLINE_PART_MAPPING_INVALID');paths.set(p.file_id,p.path);}
 const request=readOfflineJson(root,packet.request),manifest=readOfflineJson(root,packet.archive_manifest);
 const declared=new Set(manifest.items?.flatMap(i=>i.files?.flatMap(f=>f.archive?.parts?.map(p=>p.file_id)))||[]);
 if(declared.size!==paths.size||[...declared].some(id=>!paths.has(id)))fail('OFFLINE_PART_MAPPING_INVALID');
 const resolver=new ArchiveAssetResolver({root:cacheRoot,fetchPart:async({fileId,maxBytes})=>{if(!paths.has(fileId))fail('OFFLINE_PART_MAPPING_INVALID');return readOfflineFile(root,paths.get(fileId),maxBytes);}});
 try{return await ingestArchiveProduction(request,manifest,{resolver,reviewStore:new ProductionReviewStore(db)});}finally{resolver.close();}
}

export function importOfflineMetrics(db,{root,manifestPath='offline-metrics.json',now=Date.now()}={}){
 const packet=readOfflineJson(root,manifestPath);exact(packet,['schema_version','kind','targets','entries']);
 if(packet.schema_version!==1||packet.kind!=='METRIC_OBSERVATIONS'||!Array.isArray(packet.targets)||!packet.targets.length||packet.targets.length>100||!Array.isArray(packet.entries)||!packet.entries.length||packet.entries.length>100)fail('OFFLINE_MANIFEST_INVALID');
 let total=0;const entries=packet.entries.map(row=>{exact(row,['target_index','observation','evidence_path','unavailable_reason']);if(!Number.isSafeInteger(row.target_index)||!packet.targets[row.target_index])fail('OFFLINE_TARGET_INVALID');const evidenceBytes=readOfflineFile(root,row.evidence_path,5*1024*1024);total+=evidenceBytes.length;if(total>10*1024*1024)fail('OFFLINE_BATCH_SIZE_LIMIT');return {...row,evidenceBytes};});
 const store=new MetricObservationStore(db);
 return store.tx(()=>{const targets=packet.targets.map(t=>store.registerTarget(t));const receipts=entries.map(e=>{const target=packet.targets[e.target_index];return store.ingest(targets[e.target_index].id,{observation:e.observation,evidenceBytes:e.evidenceBytes,unavailable_reason:e.unavailable_reason},{workspace:target.workspace,accountId:target.account_id,now});});return {status:'IMPORTED',receipts,publish_allowed:false,source_authenticated:false};});
}
