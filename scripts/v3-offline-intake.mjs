import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {importOfflineArchive,importOfflineMetrics} from '../src/offline-intake.js';

// Explicit local administration only. No HTTP ingestion, remote transport or credential reads.
try{
 const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['kind','db','root','manifest','cache'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('OFFLINE_USAGE_INVALID');options[key]=args[i+1];}
 if(!['archive','metrics'].includes(options.kind)||!isAbsolute(options.db||'')||!existsSync(options.db)||!isAbsolute(options.root||'')||options.kind==='archive'&&!isAbsolute(options.cache||''))throw Error('USAGE: --kind archive|metrics --db EXISTING_ISOLATED_DB --root ABSOLUTE_PACKET_ROOT [--manifest RELATIVE_JSON] [--cache ABSOLUTE_PRIVATE_CACHE]');
 const db=new DatabaseSync(options.db);
 try{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='publisher_jobs'").get())throw Error('UNIFIED_DATABASE_REQUIRED');
  const input={root:options.root,...(options.manifest?{manifestPath:options.manifest}:{})};
  const result=options.kind==='archive'?await importOfflineArchive(db,{...input,cacheRoot:options.cache}):importOfflineMetrics(db,input);console.log(JSON.stringify(result));
 }finally{db.close();}
}catch(error){console.error(error.message);process.exitCode=1;}
