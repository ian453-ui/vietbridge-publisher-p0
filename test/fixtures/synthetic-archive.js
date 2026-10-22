import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const binding={project_id:'synthetic-project',account_id:'synthetic-account',content_id:'SYNTHETIC-ARCHIVE-074-TRADE'};
const python=`import base64,io,json,stat,sys,warnings,zipfile
warnings.simplefilter('ignore')
out=io.BytesIO()
with zipfile.ZipFile(out,'w') as archive:
 for row in json.load(sys.stdin):
  entry=zipfile.ZipInfo(row['name'])
  entry.create_system=3
  entry.external_attr=row.get('mode',stat.S_IFREG|0o600)<<16
  entry.compress_type=zipfile.ZIP_DEFLATED if row.get('compress') else zipfile.ZIP_STORED
  archive.writestr(entry,base64.b64decode(row['data']))
sys.stdout.buffer.write(out.getvalue())`;
export function makeZip(entries){
 const result=spawnSync('python3',['-I','-B','-c',python],{input:JSON.stringify(entries.map(e=>({...e,data:Buffer.from(e.data).toString('base64')}))),maxBuffer:16*1024*1024});
 if(result.status!==0)throw Error(String(result.stderr));return result.stdout;
}
export function archiveFixture(entries=[{name:'article.md',data:'Synthetic archive content'}],{member=entries[0].name,kind='knowledge_article',split=1,scope=binding}={}){
 const zip=makeZip(entries),memberBytes=Buffer.from(entries.find(e=>e.name===member)?.data||'missing'),parts=[],files=new Map();
 for(let i=0;i<split;i++){const data=zip.subarray(Math.floor(zip.length*i/split),Math.floor(zip.length*(i+1)/split)),file_id=split===1?'synthetic-archive':'synthetic-part-'+i;parts.push({index:i,file_id,bytes:data.length,sha256:sha256(data)});files.set(file_id,data);}
 const reference={schema_version:1,type:'ZIP_BYTE_PARTS',...scope,archive_file_id:'synthetic-archive',archive_size:zip.length,archive_sha256:sha256(zip),member_path:member,member_size:memberBytes.length,sha256:sha256(memberBytes),kind,parts};
 return {zip,reference,files,bytes:memberBytes,fetchPart:async({fileId})=>{if(!files.has(fileId))throw Error('ARCHIVE_PART_MISSING');return files.get(fileId);}};
}
