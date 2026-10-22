import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {readLocalJson} from '../src/content-workbench.js';
import {ProductionReviewStore} from '../src/production-review-store.js';

// Explicit local administrator intake; never accepts an HTTP supplied file path.
try{
 const args=process.argv.slice(2),o={};
 for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['db','request','result','root'].includes(key)||!args[i+1]||Object.hasOwn(o,key))throw Error('USAGE: --db EXISTING_ISOLATED_DB --request FILE --result FILE --root ARTIFACT_ROOT');o[key]=args[i+1];}
 if(Object.keys(o).length!==4||!isAbsolute(o.db)||!existsSync(o.db))throw Error('EXISTING_ABSOLUTE_DB_REQUIRED');
 const db=new DatabaseSync(o.db);
 try{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='publisher_jobs'").get())throw Error('UNIFIED_DATABASE_REQUIRED');
  const ledger=new ProductionReviewStore(db);console.log(JSON.stringify(ledger.ingest(readLocalJson(o.request),readLocalJson(o.result),{root:o.root})));
 }finally{db.close();}
}catch(error){console.error(error.message);process.exitCode=1;}
