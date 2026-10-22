import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {v3ReviewDemo} from './v3-review-demo.mjs';
import {MetricObservationStore} from '../src/metric-observation-store.js';
import {metricTarget,metricPacket} from '../test/fixtures/synthetic-metrics.js';

export function v3MetricDemo(out){
 const demo=v3ReviewDemo(out),db=new DatabaseSync(demo.dbPath);
 try{
  const ledger=new MetricObservationStore(db),target=metricTarget(demo),registration=ledger.registerTarget(target),scope={workspace:demo.workspace,accountId:demo.accountId};
  const packets=[metricPacket(target),metricPacket(target,{value:null,availability:'PERMISSION_DENIED',reason:'SYNTHETIC_PERMISSION_DENIED',at:'2026-10-21T11:00:00.000Z'}),metricPacket(target,{name:'reach',value:40})];
  for(const packet of packets)ledger.ingest(registration.id,packet,scope);
  const entries=packets.map((p,i)=>{const evidence_path='synthetic-metric-'+i+'.json';writeFileSync(join(out,evidence_path),p.evidenceBytes,{flag:'wx'});return {target_index:0,observation:p.observation,evidence_path,unavailable_reason:p.unavailable_reason};});
  writeFileSync(join(out,'offline-metrics.json'),JSON.stringify({schema_version:1,kind:'METRIC_OBSERVATIONS',targets:[target],entries},null,2),{flag:'wx'});
  const summary={...demo,metric_target_id:registration.id,synthetic_metric_series:ledger.list(demo.workspace,demo.accountId).snapshots.length};writeFileSync(join(out,'metric-demo.json'),JSON.stringify(summary,null,2),{flag:'wx'});return summary;
 }finally{db.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3)throw Error('USAGE: node scripts/v3-metric-demo.mjs NEW_DIRECTORY');console.log(JSON.stringify(v3MetricDemo(resolve(process.argv[2]))));}catch(error){console.error(error.message);process.exitCode=1;}
}
