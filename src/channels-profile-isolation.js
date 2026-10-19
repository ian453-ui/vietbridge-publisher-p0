import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve,dirname,basename,join} from 'node:path';

const fail=()=>{throw Error('视频号原环境目录不可核实或不能用于Facebook操作');};
// Only directory metadata. Missing new profile roots can be configured, but
// their existing ancestor must resolve; runtime getters repeat this check.
function directory(path){
 if(!isAbsolute(path||''))fail();let parent=resolve(path),tail=[];
 for(;;){
  try{
   const real=realpathSync(parent),s=lstatSync(real,{bigint:true});
   if(!s.isDirectory()||typeof s.dev!=='bigint'||s.dev<0n||typeof s.ino!=='bigint'||s.ino<=0n)fail();
   return {path:join(real,...tail),dev:tail.length?null:s.dev,ino:tail.length?null:s.ino};
  }catch(error){
   if(error.code!=='ENOENT')fail();
   // A broken symlink is unverifiable, not an uncreated directory.
   try{if(lstatSync(parent).isSymbolicLink())fail();}catch(e){if(e.code!=='ENOENT')fail();}
   if(dirname(parent)===parent)fail();tail.unshift(basename(parent));parent=dirname(parent);
  }
 }
}

/** Prevent any UUID/workspace/port alias from borrowing a Channels directory. */
export function assertNotChannelsProfile(db,profile){
 if(!db.prepare('PRAGMA table_info(facebook_accounts)').all().some(c=>c.name==='platform'))return;
 const reserved=db.prepare("SELECT DISTINCT p.id,p.user_data_dir FROM execution_profiles p JOIN facebook_accounts a ON a.profile_id=p.id WHERE a.platform='wechat_channels'").all();
 if(!reserved.length)return;
 if(!profile||reserved.some(p=>p.id===profile.id))fail();
 const candidate=directory(profile.user_data_dir);
 for(const row of reserved){
  const original=directory(row.user_data_dir);
  if(original.dev===null||original.ino===null)fail();
  if(candidate.path===original.path||candidate.dev===original.dev&&candidate.ino===original.ino)fail();
 }
}
