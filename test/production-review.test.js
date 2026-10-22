import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {v3ReviewDemo} from '../scripts/v3-review-demo.mjs';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {createProductionRequest,packageProductionResult} from '../src/production-artifact-contract.js';
import {createApp} from '../src/server.js';
import {PublisherAccess} from '../src/publisher-access.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'v3-review-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const out=join(root,'demo'),demo=v3ReviewDemo(out),db=new DatabaseSync(demo.dbPath);t.after(()=>db.close());
 const ledger=new ProductionReviewStore(db),request=JSON.parse(readFileSync(join(out,'request.json'))),result=JSON.parse(readFileSync(join(out,'result.json')));
 return {root,out,demo,db,ledger,request,result};
}
test('scoped production receipts and exact media survive restart without a publication job',t=>{
 const {demo,db,ledger,request,result}=fixture(t);
 assert.equal(ledger.ingest(request,result,{root:demo.artifactRoot}).status,'DUPLICATE');
 assert.equal(ledger.list(demo.workspace,demo.accountId).length,1);
 assert.equal(db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
 const reopened=new DatabaseSync(demo.dbPath);try{
  const persisted=new ProductionReviewStore(reopened),report=persisted.detail(demo.workspace,demo.accountId,demo.id);
  assert.equal(report.status,'REVIEW_REQUIRED');assert.equal(report.publish_allowed,false);assert.equal(report.import_allowed,false);
  const video=persisted.asset(demo.workspace,demo.accountId,demo.id,'SYNTHETIC-VIDEO-001','video');
  assert.equal(createHash('sha256').update(video.data).digest('hex'),video.sha256);
  // The preview is frozen, not a later read of a mutable source file.
  writeFileSync(join(demo.artifactRoot,'SYNTHETIC-VIDEO-001/video.mp4'),'changed');
  assert.deepEqual(persisted.asset(demo.workspace,demo.accountId,demo.id,'SYNTHETIC-VIDEO-001','video').data,video.data);
 }finally{reopened.close();}
});
test('conflicting results, reassignment and changed bytes cannot overwrite durable review',t=>{
 const {demo,ledger,request,result,db}=fixture(t);
 const conflict=structuredClone(result);conflict.completed_at=new Date(Date.parse(conflict.completed_at)-1).toISOString();
 assert.throws(()=>ledger.ingest(request,conflict,{root:demo.artifactRoot}),/CONFLICTING_RESULT/);
 const {request_fingerprint,assignment_mode,handoff_policy,...plan}=request;plan.current_owner='MAC_CODEX';
 const changed=createProductionRequest(plan),selections=JSON.parse(readFileSync(join(demo.artifactRoot,'../selections.json'))),changedResult=packageProductionResult(changed,selections,{root:demo.artifactRoot});
 assert.throws(()=>ledger.ingest(changed,changedResult,{root:demo.artifactRoot}),/REQUEST_IDENTITY_CHANGE/);
 assert.throws(()=>ledger.detail('another-workspace',demo.accountId,demo.id),/REVIEW_SCOPE_DENIED/);
 assert.throws(()=>ledger.detail(demo.workspace,'another-account',demo.id),/REVIEW_SCOPE_DENIED/);
 assert.throws(()=>ledger.detail(demo.otherWorkspace,demo.otherAccountId,demo.id),/REVIEW_NOT_FOUND/);
 assert.deepEqual(ledger.list(demo.otherWorkspace,demo.otherAccountId),[]);
 plan.current_owner=request.current_owner;plan.workspace=demo.otherWorkspace;plan.account_id=demo.otherAccountId;
 const reassigned=createProductionRequest(plan),reassignedResult=packageProductionResult(reassigned,selections,{root:demo.artifactRoot});
 assert.throws(()=>ledger.ingest(reassigned,reassignedResult,{root:demo.artifactRoot}),/REQUEST_IDENTITY_CHANGE/);
 assert.equal(db.prepare('SELECT count(*) n FROM production_reviews').get().n,1);
 db.prepare("UPDATE production_review_assets SET data=? WHERE artifact_id='video'").run(Buffer.from('damaged'));
 assert.throws(()=>ledger.asset(demo.workspace,demo.accountId,demo.id,'SYNTHETIC-VIDEO-001','video'),/REVIEW_STORAGE_CORRUPT/);
});
test('bad video fails atomically before creating a durable receipt or any READY/publication state',t=>{
 const {demo,ledger,request,result,db}=fixture(t);db.exec('DELETE FROM production_review_assets; DELETE FROM production_reviews');
 writeFileSync(join(demo.artifactRoot,'SYNTHETIC-VIDEO-001/video.mp4'),'Deliberately NOT a playable video: tests bytes-only boundary.');
 assert.throws(()=>ledger.ingest(request,result,{root:demo.artifactRoot}),/VIDEO_/);
 assert.equal(db.prepare('SELECT count(*) n FROM production_reviews').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM production_review_assets').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
});
test('existing authentication guards Review API; cross-scope reads and every write are denied',async t=>{
 const {demo,root}=fixture(t),cloud={mode:'cloud',executionConnected:false,origin:'https://fixture.invalid',host:'fixture.invalid',user:'synthetic-admin',password:'synthetic-disposable-test-password',dataDir:root};
 const app=createApp(demo.dbPath,{unified:true,cloud});t.after(()=>app.emit('close'));
 const auth={authorization:'Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64')};
 async function call(path,headers={},method='GET'){
  const req=Readable.from([]);Object.assign(req,{url:path,method,headers:{host:cloud.host,...headers}});
  let status=200,body;const responseHeaders={};const res={setHeader(k,v){responseHeaders[k]=v;},writeHead(s){status=s;},end(b){body=b;}};
  await app.listeners('request')[0](req,res);return {status,body,headers:responseHeaders};
 }
 const query=new URLSearchParams({workspace:demo.workspace,accountId:demo.accountId}),path='/api/production-reviews?'+query;
 assert.equal((await call(path)).status,401);assert.equal((await call(path,auth)).status,200);
 assert.equal((await call('/api/production-reviews?workspace=other&accountId='+demo.accountId,auth)).status,403);
 assert.equal((await call('/api/production-reviews/'+'f'.repeat(64)+'?'+query,auth)).status,404);
 for(const method of ['POST','PUT','DELETE','PATCH'])assert.equal((await call(path,auth,method)).status,405);
 const asset=await call('/api/production-reviews/'+demo.id+'/asset?'+query+'&source=SYNTHETIC-VIDEO-001&artifact=video',auth);
 assert.equal(asset.status,200);assert.equal(asset.headers['Content-Type'],'video/mp4');assert.equal(asset.headers['X-Content-Type-Options'],'nosniff');
 const access=new PublisherAccess(cloud);
 assert.equal(access.authorizeApp({type:'app',token:{workspaces:[demo.workspace],scopes:['jobs:read','content:import','jobs:create']}},'GET',new URL(path,cloud.origin)),false);
});
