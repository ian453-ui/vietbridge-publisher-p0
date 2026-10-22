import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {v3ReviewDemo} from '../scripts/v3-review-demo.mjs';
import {MetricObservationStore} from '../src/metric-observation-store.js';
import {collectMetricOnce} from '../src/metric-collector.js';
import {metricTarget,metricPacket,metricSelector,metricNow} from './fixtures/synthetic-metrics.js';

export function fixture(t){const root=mkdtempSync(join(tmpdir(),'v3-metrics-')),demo=v3ReviewDemo(join(root,'demo')),db=new DatabaseSync(demo.dbPath),ledger=new MetricObservationStore(db),target=metricTarget(demo),id=ledger.registerTarget(target).id,scope={workspace:demo.workspace,accountId:demo.accountId,now:metricNow};t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,demo,db,ledger,target,id,scope};}
test('durable canonical observations and raw evidence survive restart; repeats are idempotent',t=>{
 const f=fixture(t),packet=metricPacket(f.target),before=JSON.stringify(packet),receipt=f.ledger.ingest(f.id,packet,f.scope);assert.equal(receipt.status,'RECORDED');assert.equal(f.ledger.ingest(f.id,packet,f.scope).status,'DUPLICATE');assert.equal(JSON.stringify(packet),before);
 const db=new DatabaseSync(f.demo.dbPath);try{const reopened=new MetricObservationStore(db),report=reopened.list(f.demo.workspace,f.demo.accountId);assert.equal(report.snapshots[0].value,100);assert.deepEqual(Buffer.from(reopened.evidence(receipt.id,f.scope).data),packet.evidenceBytes);assert.equal(reopened.history(receipt.series_id,f.scope).entries.length,1);}finally{db.close();}
 assert.equal(f.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
});
test('same-time conflict keeps both records/raw bytes and current value null, never overwrites',t=>{
 const f=fixture(t),a=f.ledger.ingest(f.id,metricPacket(f.target),f.scope),b=f.ledger.ingest(f.id,metricPacket(f.target,{value:80}),f.scope);
 assert.equal(b.status,'CONFLICT_RETAINED');assert.equal(b.conflicting_ids.length,2);assert.equal(f.ledger.snapshot(a.series_id,f.scope).status,'CONFLICT');assert.equal(f.ledger.snapshot(a.series_id,f.scope).value,null);assert.equal(f.ledger.history(a.series_id,f.scope).entries.length,2);assert.equal(f.db.prepare('SELECT count(*) n FROM metric_raw_evidence').get().n,2);
});
test('explicit unavailable reason and latest failure replace stale value; zero and as-of history stay distinct',t=>{
 const f=fixture(t),old=f.ledger.ingest(f.id,metricPacket(f.target,{value:0}),f.scope),later=metricPacket(f.target,{value:null,availability:'PERMISSION_DENIED',reason:'SYNTHETIC_DENIED',at:'2026-10-21T11:00:00.000Z'});
 assert.throws(()=>f.ledger.ingest(f.id,{...later,unavailable_reason:null},f.scope),/REASON_REQUIRED/);f.ledger.ingest(f.id,later,f.scope);
 assert.equal(f.ledger.snapshot(old.series_id,f.scope).value,null);assert.equal(f.ledger.snapshot(old.series_id,f.scope).reason,'SYNTHETIC_DENIED');assert.equal(f.ledger.snapshot(old.series_id,{...f.scope,asOf:'2026-10-21T10:30:00.000Z'}).value,0);
});
test('reach/views, definition versions and exact reporting windows remain separate without aggregation',t=>{
 const f=fixture(t),packets=[metricPacket(f.target),metricPacket(f.target,{name:'reach',value:30}),metricPacket(f.target,{window:{kind:'UNKNOWN',start:null,end:null,timezone:null}}),metricPacket(f.target)];packets[3].observation.metric.definition_version='2';for(const p of packets)f.ledger.ingest(f.id,p,f.scope);
 const report=f.ledger.list(f.demo.workspace,f.demo.accountId);assert.equal(report.snapshots.length,4);assert.equal(report.aggregation,'NOT_PERFORMED');assert.equal(report.snapshots.filter(x=>x.selector.metric.name==='reach').length,1);
});
test('scope, platform, task, post, job, revision and established account identity cannot be reassigned',t=>{
 const f=fixture(t);assert.throws(()=>f.ledger.registerTarget({...f.target,operator_actor_id:'wrong'}),/IDENTITY/);
 for(const key of ['content_revision','content_id','object_id','task_id'])assert.throws(()=>f.ledger.registerTarget({...f.target,[key]:'changed',...(key==='object_id'?{source_object_id:'changed'}:{})}),/CONFLICT/);
 assert.throws(()=>f.ledger.registerTarget({...f.target,workspace:f.demo.otherWorkspace,account_id:f.demo.otherAccountId,platform:'xiaohongshu',publication_job_id:'other-job'}),/TASK_SCOPE_CONFLICT/);
 assert.throws(()=>f.ledger.registerTarget({...f.target,platform:'xiaohongshu'}),/PLATFORM/);
 assert.throws(()=>f.ledger.list(f.demo.otherWorkspace,f.demo.accountId),/SCOPE_DENIED/);
 assert.throws(()=>f.ledger.target(f.id,{workspace:f.demo.otherWorkspace,accountId:f.demo.otherAccountId}),/NOT_FOUND/);
 for(const key of ['workspace','account_id','platform','object_id','publication_job_id','content_revision']){const packet=metricPacket(f.target);packet.observation[key]='wrong';assert.throws(()=>f.ledger.ingest(f.id,packet,f.scope),/SCOPE_MISMATCH/);}
 const changedSource=metricPacket(f.target);changedSource.observation.source.reference='fixture:unapproved-source';assert.throws(()=>f.ledger.ingest(f.id,changedSource,f.scope),/SOURCE_BINDING_MISMATCH/);
});
test('raw insertion failure rolls back observation and series; altered persisted bytes fail closed',t=>{
 const f=fixture(t),packet=metricPacket(f.target);f.db.exec("CREATE TEMP TRIGGER fail_raw BEFORE INSERT ON metric_raw_evidence BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RAW_FAILURE'); END");assert.throws(()=>f.ledger.ingest(f.id,packet,f.scope),/RAW_FAILURE/);assert.equal(f.db.prepare('SELECT count(*) n FROM metric_observations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM metric_series').get().n,0);f.db.exec('DROP TRIGGER fail_raw');const receipt=f.ledger.ingest(f.id,packet,f.scope);f.db.prepare('UPDATE metric_raw_evidence SET data=? WHERE observation_id=?').run(Buffer.from('corrupt'),receipt.id);assert.throws(()=>f.ledger.evidence(receipt.id,f.scope),/STORAGE_CORRUPT/);assert.throws(()=>f.ledger.snapshot(receipt.series_id,f.scope),/STORAGE_CORRUPT/);
});
test('pagination exposes all distinct definitions and historical observations without silently truncating',t=>{
 const f=fixture(t);let receipt;
 for(let i=0;i<22;i++){const p=metricPacket(f.target);p.observation.metric.definition_version=String(i);f.ledger.ingest(f.id,p,f.scope);}
 const first=f.ledger.list(f.demo.workspace,f.demo.accountId),second=f.ledger.list(f.demo.workspace,f.demo.accountId,{cursor:first.next_cursor,asOf:first.as_of});assert.equal(first.snapshots.length,20);assert.equal(second.snapshots.length,2);assert.equal(second.next_cursor,null);
 for(let i=0;i<22;i++)receipt=f.ledger.ingest(f.id,metricPacket(f.target,{at:new Date(metricNow-i*1000).toISOString(),value:i}),f.scope);
 const page1=f.ledger.history(receipt.series_id,f.scope),page2=f.ledger.history(receipt.series_id,{...f.scope,before:page1.next_cursor});assert.equal(page1.entries.length,20);assert.equal(page2.entries.length,3);assert.equal(page2.next_cursor,null);assert.equal(new Set([...page1.entries,...page2.entries].map(x=>x.id)).size,23);
});
test('read-only collector persists failure/timeout/invalid result, pending restart, and never retries',async t=>{
 const f=fixture(t),packet=metricPacket(f.target),shape=metricSelector(packet),receipt=f.ledger.ingest(f.id,packet,f.scope);let calls=0;
 const failure=await collectMetricOnce(f.ledger,f.id,shape,{...f.scope,now:()=>metricNow,adapter:{readOnly:true,read(){calls++;throw Error('secret credential text must not persist');}}});assert.equal(failure.reason,'COLLECTOR_FAILED');assert.equal(calls,1);assert.equal(f.ledger.snapshot(receipt.series_id,f.scope).value,null);
 const timeout=await collectMetricOnce(f.ledger,f.id,shape,{...f.scope,now:()=>metricNow+1000,timeoutMs:10,adapter:{readOnly:true,read:()=>new Promise(()=>{})}});assert.equal(timeout.reason,'COLLECTOR_TIMEOUT');
 const invalid=await collectMetricOnce(f.ledger,f.id,shape,{...f.scope,now:()=>metricNow+2000,adapter:{readOnly:true,read:()=>({...packet,evidenceBytes:Buffer.from('invalid')})}});assert.equal(invalid.reason,'COLLECTOR_INVALID_RESULT');
 const pending=f.ledger.beginCollection(f.id,shape,{...f.scope,now:metricNow+3000});const second=new DatabaseSync(f.demo.dbPath);try{assert.equal(new MetricObservationStore(second).snapshot(pending.series_id,f.scope).status,'COLLECTION_PENDING');}finally{second.close();}
 f.ledger.failCollection(pending.id,{...f.scope,now:metricNow+4000,reason:'COLLECTOR_INTERRUPTED'});assert.equal(f.ledger.snapshot(pending.series_id,f.scope).reason,'COLLECTOR_INTERRUPTED');
 const recent=metricPacket(f.target,{at:'2026-10-21T12:01:00.000Z',value:90});const success=await collectMetricOnce(f.ledger,f.id,metricSelector(recent),{...f.scope,now:()=>metricNow+60000,adapter:{readOnly:true,read:()=>recent}});assert.equal(success.status,'RECORDED');assert.equal(f.ledger.snapshot(receipt.series_id,f.scope).value,90);
 assert.equal(f.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
});
test('two independent SQLite processes racing duplicate input persist one observation and raw record',async t=>{
 const f=fixture(t),input={id:f.id,scope:f.scope,packet:metricPacket(f.target)},path=join(f.root,'packet.json');input.packet.evidenceBytes=input.packet.evidenceBytes.toString('base64');writeFileSync(path,JSON.stringify(input));const gate=join(f.root,'go');
 const code=`import {DatabaseSync} from 'node:sqlite';import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {MetricObservationStore} from './src/metric-observation-store.js';const [path,dbPath,gate,ready]=process.argv.slice(1),x=JSON.parse(readFileSync(path));x.packet.evidenceBytes=Buffer.from(x.packet.evidenceBytes,'base64');const db=new DatabaseSync(dbPath),s=new MetricObservationStore(db);writeFileSync(ready,'ready');while(!existsSync(gate))await new Promise(r=>setTimeout(r,5));try{console.log(JSON.stringify(s.ingest(x.id,x.packet,x.scope)));}finally{db.close();}`;
 const run=promisify(execFile),jobs=[0,1].map(i=>run(process.execPath,['--input-type=module','-e',code,path,f.demo.dbPath,gate,join(f.root,i+'.ready')],{timeout:15000}));const until=Date.now()+5000;while(![0,1].every(i=>existsSync(join(f.root,i+'.ready')))&&Date.now()<until)await new Promise(r=>setTimeout(r,10));writeFileSync(gate,'go');
 assert.deepEqual((await Promise.all(jobs)).map(x=>JSON.parse(x.stdout).status).sort(),['DUPLICATE','RECORDED']);assert.equal(f.db.prepare('SELECT count(*) n FROM metric_raw_evidence').get().n,1);
});

test('as-of normalizes future completion before choosing the controlling attempt, including after restart',t=>{
 const f=fixture(t),at=seconds=>metricNow+seconds*1000,packet=metricPacket(f.target,{at:new Date(at(5)).toISOString()}),shape=metricSelector(packet);
 const a=f.ledger.beginCollection(f.id,shape,{...f.scope,now:at(0)});const receipt=f.ledger.ingest(f.id,packet,{...f.scope,now:at(5)});const b=f.ledger.beginCollection(f.id,shape,{...f.scope,now:at(10)});
 f.ledger.failCollection(b.id,{...f.scope,now:at(15)});f.ledger.failCollection(a.id,{...f.scope,now:at(20)});
 for(const db of [f.db,new DatabaseSync(f.demo.dbPath)]){try{const report=new MetricObservationStore(db).snapshot(receipt.series_id,{...f.scope,asOf:new Date(at(18)).toISOString()});assert.equal(report.status,'COLLECTION_FAILED');assert.equal(report.value,null);assert.equal(report.collection_attempt.id,b.id);}finally{if(db!==f.db)db.close();}}
});
test('late failure from an older collection generation cannot override newer successful generation',t=>{
 const f=fixture(t),at=seconds=>metricNow+seconds*1000,packet=metricPacket(f.target,{at:new Date(at(12)).toISOString(),value:200}),shape=metricSelector(packet);
 const a=f.ledger.beginCollection(f.id,shape,{...f.scope,now:at(0)}),b=f.ledger.beginCollection(f.id,shape,{...f.scope,now:at(10)});const receipt=f.ledger.ingest(f.id,packet,{...f.scope,attemptId:b.id,now:at(12)});f.ledger.failCollection(a.id,{...f.scope,now:at(20)});
 for(const db of [f.db,new DatabaseSync(f.demo.dbPath)]){try{const report=new MetricObservationStore(db).snapshot(receipt.series_id,{...f.scope,asOf:new Date(at(30)).toISOString()});assert.equal(report.status,'AVAILABLE');assert.equal(report.value,200);}finally{if(db!==f.db)db.close();}}
});
test('older late success is retained as history; duplicate success links to the newer generation',t=>{
 const f=fixture(t),at=s=>metricNow+s*1000,p=metricPacket(f.target,{value:200,at:new Date(at(12)).toISOString()}),shape=metricSelector(p),a=f.ledger.beginCollection(f.id,shape,{...f.scope,now:at(0)}),b=f.ledger.beginCollection(f.id,shape,{...f.scope,now:at(10)});
 const accepted=f.ledger.ingest(f.id,p,{...f.scope,attemptId:b.id,now:at(12)});f.ledger.ingest(f.id,metricPacket(f.target,{value:90,at:new Date(at(20)).toISOString()}),{...f.scope,attemptId:a.id,now:at(20)});
 assert.equal(f.ledger.snapshot(accepted.series_id,f.scope).value,200);assert.equal(f.ledger.history(accepted.series_id,f.scope).entries.length,2);
 const c=f.ledger.beginCollection(f.id,shape,{...f.scope,now:at(25)});assert.equal(f.ledger.ingest(f.id,p,{...f.scope,attemptId:c.id,now:at(30)}).status,'DUPLICATE');assert.equal(f.ledger.snapshot(accepted.series_id,f.scope).value,200);assert.equal(f.db.prepare('SELECT count(*) n FROM metric_attempt_observations').get().n,3);
});
test('legacy attempts with no recorded generation remain explicitly unknown until a fresh ordered attempt',t=>{
 const f=fixture(t),p=metricPacket(f.target),shape=metricSelector(p),receipt=f.ledger.ingest(f.id,p,f.scope),a=f.ledger.beginCollection(f.id,shape,f.scope);f.ledger.failCollection(a.id,f.scope);f.db.exec('UPDATE metric_collection_attempts SET generation=0');
 const db=new DatabaseSync(f.demo.dbPath);try{const ledger=new MetricObservationStore(db),snapshot=ledger.snapshot(receipt.series_id,f.scope);assert.equal(snapshot.status,'COLLECTION_ORDER_UNKNOWN');assert.equal(snapshot.value,null);assert.equal(ledger.history(receipt.series_id,f.scope).entries.length,1);
 const next=ledger.beginCollection(f.id,shape,{...f.scope,now:metricNow+1000});ledger.ingest(f.id,metricPacket(f.target,{value:120,at:new Date(metricNow+1000).toISOString()}),{...f.scope,attemptId:next.id,now:metricNow+1000});assert.equal(ledger.snapshot(receipt.series_id,f.scope).value,120);
 }finally{db.close();}
});
