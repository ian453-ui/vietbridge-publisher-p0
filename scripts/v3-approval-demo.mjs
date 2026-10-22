import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {v3ReviewDemo} from './v3-review-demo.mjs';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {seedSyntheticApproval} from '../test/fixtures/synthetic-approval.js';

/** Explicit fixture only: seeds no credential, session, live producer or publication. */
export function v3ApprovalDemo(out){
 const demo=v3ReviewDemo(out),db=new DatabaseSync(demo.dbPath);
 try{const approval=seedSyntheticApproval(new ProductionReviewStore(db),demo.id,{workspace:demo.workspace,accountId:demo.accountId});const summary={...demo,approval_state:approval.state,producer_authenticated:false,synthetic_fixture:true,requires_existing_admin:true};writeFileSync(join(out,'approval-demo.json'),JSON.stringify(summary,null,2),{flag:'wx'});return summary;}finally{db.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3)throw Error('USAGE: node scripts/v3-approval-demo.mjs NEW_DIRECTORY');console.log(JSON.stringify(v3ApprovalDemo(resolve(process.argv[2]))));}catch(error){console.error(error.message);process.exitCode=1;}
}
