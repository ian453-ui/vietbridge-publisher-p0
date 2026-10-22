import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {createProductionRequest,packageProductionResult} from '../src/production-artifact-contract.js';
import {productionDemo} from './production-artifact-demo.mjs';

export function v3ReviewDemo(out){
 mkdirSync(out);const bundle=join(out,'production');productionDemo(bundle);
 const dbPath=join(out,'publisher-unified.sqlite'),store=new Store(dbPath,{seedDemo:false});
 try{
  const publisher=new UnifiedPublisher(store),workspace=store.saveWorkspace({name:'Synthetic V3 customer'});
  const profile=store.saveProfile(workspace.id,{name:'Synthetic inactive profile',cdp_port:19889,user_data_dir:join(out,'never-launched-profile')});
  const account=publisher.saveAccount(workspace.id,{platform:'facebook',display_name:'Synthetic V3 account',expected_identity:'SYNTHETIC ONLY',profile_id:profile.id,identity_type:'PAGE',external_id:'900000000000002',operator_actor_id:'900000000000002',target_page_id:'900000000000001'});
  const plan=JSON.parse(readFileSync(join(bundle,'plan.json'),'utf8'));plan.workspace=workspace.id;plan.account_id=account.id;
  const request=createProductionRequest(plan),root=join(bundle,'artifacts'),selections=JSON.parse(readFileSync(join(bundle,'selections.json'),'utf8')),result=packageProductionResult(request,selections,{root});
  for(const [name,value] of Object.entries({request,result}))writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2),{flag:'wx'});
  const receipt=new ProductionReviewStore(store.db).ingest(request,result,{root});
  const otherWorkspace=store.saveWorkspace({name:'Synthetic isolated customer'});
  const otherAccount=publisher.saveAccount(otherWorkspace.id,{platform:'xiaohongshu',display_name:'Synthetic other account',expected_identity:'SYNTHETIC OTHER',external_id:'username:synthetic-other'});
  const secondAccount=publisher.saveAccount(workspace.id,{platform:'xiaohongshu',display_name:'Synthetic same-customer second account',expected_identity:'SYNTHETIC SECOND',external_id:'username:synthetic-second',publisher_options:{mcp_endpoint:'http://127.0.0.1:19998/mcp'}});
  publisher.selectAccount(workspace.id,account.id);
  const summary={...receipt,synthetic_only:true,dbPath,workspace:workspace.id,accountId:account.id,secondAccountId:secondAccount.id,otherWorkspace:otherWorkspace.id,otherAccountId:otherAccount.id,artifactRoot:root};
  writeFileSync(join(out,'demo.json'),JSON.stringify(summary,null,2),{flag:'wx'});return summary;
 }finally{store.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3)throw Error('USAGE: node scripts/v3-review-demo.mjs NEW_DIRECTORY');console.log(JSON.stringify(v3ReviewDemo(resolve(process.argv[2]))));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
