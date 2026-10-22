import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {v3ArchiveDemo} from './v3-archive-demo.mjs';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {GroupLibrary} from '../src/library.js';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {MetricObservationStore} from '../src/metric-observation-store.js';
import {seedSyntheticApproval} from '../test/fixtures/synthetic-approval.js';
import {metricTarget,metricPacket} from '../test/fixtures/synthetic-metrics.js';

/** Offline synthetic fixtures only. Review output is never promoted into publication input. */
export async function v3AcceptanceDemo(out){
 const demo=await v3ArchiveDemo(out),store=new Store(demo.dbPath,{seedDemo:false});
 try{
  const publisher=new UnifiedPublisher(store),scope={workspace:demo.workspace,accountId:demo.accountId};
  const libraryRoot=join(out,'synthetic-library'),snapshotRoot=join(out,'synthetic-library-snapshots');
  for(const id of [demo.workspace,demo.otherWorkspace]){const content_root=join(libraryRoot,'clients',id);mkdirSync(join(content_root,'READY/content'),{recursive:true});mkdirSync(join(content_root,'READY/assets'));store.saveWorkspace({...store.list('workspaces').find(w=>w.id===id),content_root});writeFileSync(join(content_root,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[]}));}
  const clientRoot=join(libraryRoot,'clients',demo.workspace),items=['SYNTHETIC-20261020-074-TRADE','SYNTHETIC-20261021-074-PERMIT'].map((source_id,i)=>{
   const primary_image='READY/assets/'+source_id+'.png';copyFileSync(join(demo.artifactRoot,i?'SYNTHETIC-VIDEO-001/cover.png':'SYNTHETIC-KB-003/cover.png'),join(clientRoot,primary_image));
   const body='SYNTHETIC LEGACY INPUT '+source_id+'\n'+Array.from({length:24},(_,p)=>'Paragraph '+p+': '+(i?'Permit revision':'Trade revision')+' full content.').join('\n')+'\nEND-'+source_id;
   const body_source='READY/content/'+source_id+'.md';writeFileSync(join(clientRoot,body_source),'---\npublish_caption: '+JSON.stringify(body)+'\n---\n# '+(i?'Synthetic permit 074':'Synthetic trade 074'));
   return {content_id:source_id,status:'READY',body_source,primary_image,content_revision:1,visual_revision:1};
  });
  writeFileSync(join(clientRoot,'publisher-manifest.json'),JSON.stringify({status:'READY',items}));
  const library=new GroupLibrary(store,{roots:[libraryRoot],snapshotRoot,gptInboxBase:null}),selections=library.items(demo.workspace).map(({key,revision})=>({key,revision})),contents=library.import(demo.workspace,selections);
  const jobs=contents.map(c=>publisher.createPageJob(demo.workspace,{account_id:demo.accountId,content_id:c.id}));
  const xhsContent=publisher.importContent(demo.workspace,{source_id:'SYNTHETIC-XHS-INDEPENDENT',revision:'1',title:'Trade fixture',body:'SYNTHETIC XHS COPY independent supplied version',media:JSON.parse(contents[0].media_json)});
  const secondJob=publisher.createPageJob(demo.workspace,{account_id:demo.secondAccountId,content_id:xhsContent.id});
  const approvals=new ProductionReviewStore(store.db).approvals;
  seedSyntheticApproval({db:store.db,approvals},demo.archive_receipt.id,scope);
  const ledger=new MetricObservationStore(store.db),target=metricTarget(demo),registration=ledger.registerTarget(target);
  // Deliberately a separate synthetic publication mapping, not a claim these DRAFT jobs published.
  for(const packet of [metricPacket(target),metricPacket(target,{name:'reach',value:40}),metricPacket(target,{value:null,availability:'PERMISSION_DENIED',reason:'SYNTHETIC_PERMISSION_DENIED',at:'2026-10-21T11:00:00.000Z'})])ledger.ingest(registration.id,packet,scope);
  const summary={...demo,libraryRoot,snapshotRoot,contentIds:contents.map(c=>c.id),xhsContentId:xhsContent.id,draftJobIds:jobs.map(j=>j.id),secondAccountDraftId:secondJob.id,metricTargetId:registration.id,publication_link:'SEPARATE_SYNTHETIC_MAPPING_NOT_FROM_REVIEW',publish_allowed:false};
  writeFileSync(join(out,'acceptance-demo.json'),JSON.stringify(summary,null,2),{flag:'wx'});
  return summary;
 }finally{store.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3)throw Error('USAGE: node scripts/v3-acceptance-demo.mjs NEW_DIRECTORY');console.log(JSON.stringify(await v3AcceptanceDemo(resolve(process.argv[2]))));}catch(error){console.error(error.message);process.exitCode=1;}
}
