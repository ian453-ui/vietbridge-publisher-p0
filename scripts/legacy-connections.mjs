import {existsSync,realpathSync,statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {previewLegacyConnections,registerLegacyConnections,rollbackLegacyConnections} from '../src/legacy-connections.js';
const [operation,...args]=process.argv.slice(2),input=Object.fromEntries(args.map(a=>{const i=a.indexOf('=');if(i<1)throw Error('Use named key=value arguments');return [a.slice(0,i),a.slice(i+1)];}));
if(!['preview','register','rollback'].includes(operation)||!input.db||!existsSync(input.db))throw Error('Existing DB and explicit preview/register/rollback required');
const dbPath=realpathSync(input.db);if(!statSync(dbPath).isFile())throw Error('Existing DB file required');
const options={workspace:input.workspace,legacyRoot:input.legacy_root,preview_hash:input.preview_hash,confirm_workspace:input.confirm_workspace,migration_id:input.migration_id,rows_hash:input.rows_hash};

function existingSchema(db){
 const required={records:['kind','id','workspace','value'],events:['seq','workspace','event','value','created_at'],facebook_accounts:['id','workspace','platform','publisher_transport','publisher_options_json','config_url','execution_transport','profile_id','external_id','expected_identity','session_health','enabled'],execution_profiles:['id','workspace','name','cdp_port','user_data_dir','status','last_error'],workspace_preferences:['workspace','key','value'],publisher_jobs:['id','account_id','snapshot_json','state']};
 for(const [table,columns] of Object.entries(required)){
  const existing=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
  if(columns.some(c=>!existing.includes(c)))throw Error('Existing unified metadata schema required: '+table);
 }
}

// Neither constructor is safe for metadata work: both initialize schema and
// Store recovers historical work even with seedDemo:false. Reuse only the
// existing metadata methods, on a validated schema and explicit transaction.
const probe=new DatabaseSync(dbPath,{readOnly:true});
try{
 existingSchema(probe);
 if(operation==='preview')console.log(JSON.stringify(previewLegacyConnections(probe,options),null,2));
 else if(operation==='register')previewLegacyConnections(probe,options);
}finally{probe.close();}
if(operation!=='preview'){
 const db=new DatabaseSync(dbPath),store=Object.create(Store.prototype),publisher=Object.create(UnifiedPublisher.prototype);
 store.db=db;publisher.db=db;publisher.store=store;
 try{
  existingSchema(db);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const result=operation==='register'?registerLegacyConnections(publisher,options):rollbackLegacyConnections(publisher,options);
  console.log(JSON.stringify({workspace:result.workspace,migration_id:result.migration_id,rows_hash:result.rows_hash,already_applied:result.already_applied,rolled_back:result.rolled_back,account_ids:result.accounts?.map(a=>a.id),profile_ids:result.profiles?.map(p=>p.id),metadata_only:true},null,2));
 }finally{db.close();}
}
