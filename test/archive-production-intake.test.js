import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {v3ArchiveDemo} from '../scripts/v3-archive-demo.mjs';
import {ingestArchiveProduction} from '../src/archive-production-intake.js';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {ArchiveAssetResolver} from '../src/archive-asset-resolver.js';

test('real synthetic ZIP parts -> selected media -> existing production Review ledger; loose reading remains intact',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-archive-e2e-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const out=join(root,'demo'),demo=await v3ArchiveDemo(out);
 assert.equal(demo.archive_receipt.status,'REVIEW_REQUIRED');assert.equal(demo.archive_receipt.archive_members,10);assert.equal(demo.archive_receipt.upload_input,'EXTRACTED_LOCAL_MEDIA');assert.equal(demo.archive_receipt.publish_allowed,false);
 const db=new DatabaseSync(demo.dbPath);try{
  const reviews=new ProductionReviewStore(db),archive=reviews.detail(demo.workspace,demo.accountId,demo.archive_receipt.id),loose=reviews.detail(demo.workspace,demo.accountId,demo.id);
  for(const item of archive.items)for(const asset of item.artifacts){const old=loose.items.find(x=>x.source_id===item.source_id).artifacts.find(x=>x.artifact_id===asset.artifact_id);assert.equal(asset.sha256,old.sha256);}
  const video=archive.items.find(x=>x.source_id==='SYNTHETIC-VIDEO-001').artifacts.find(x=>x.kind==='video');assert.equal(video.validation.level,'VIDEO_DECODED');
  assert.equal(db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);assert.equal(readdirSync(demo.cold_directory).length,3);assert.ok(readFileSync(join(demo.artifactRoot,'SYNTHETIC-VIDEO-001/video.mp4')).length>0);
  const request=JSON.parse(readFileSync(join(out,'archive-request.json'))),manifest=JSON.parse(readFileSync(demo.archive_manifest));
  const resolver=new ArchiveAssetResolver({root:join(out,'archive-hot-cache'),fetchPart:()=>{throw Error('unexpected redownload')}});try{
   const duplicate=await ingestArchiveProduction(request,manifest,{resolver,reviewStore:reviews});assert.equal(duplicate.status,'DUPLICATE');assert.equal(resolver.db.prepare('SELECT count(*) n FROM archive_leases').get().n,0);
  }finally{resolver.close();}
 }finally{db.close();}
});

test('first or second lease release failure still attempts every release and preserves committed receipt',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-archive-cleanup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const out=join(root,'demo'),demo=await v3ArchiveDemo(out),db=new DatabaseSync(demo.dbPath),request=JSON.parse(readFileSync(join(out,'archive-request.json'))),manifest=JSON.parse(readFileSync(demo.archive_manifest));
 const real=new ArchiveAssetResolver({root:join(out,'archive-hot-cache'),fetchPart:()=>{throw Error('unexpected transfer')}}),reviewStore=new ProductionReviewStore(db);
 try{for(const failAt of [0,1]){
  db.prepare('DELETE FROM production_review_assets WHERE review_id=?').run(demo.archive_receipt.id);db.prepare('DELETE FROM production_reviews WHERE id=?').run(demo.archive_receipt.id);
  const visited=[];let retained;
  const resolver={resolve:(...args)=>real.resolve(...args),release:(id,scope)=>{visited.push(id);if(visited.length-1===failAt){retained={id,scope};throw Error('SYNTHETIC_RELEASE_FAILURE');}real.release(id,scope);}};
  const receipt=await ingestArchiveProduction(request,manifest,{resolver,reviewStore});
  assert.equal(receipt.status,'REVIEW_REQUIRED');assert.equal(receipt.cleanup_status,'RECONCILE_PENDING');assert.equal(receipt.cleanup_pending.length,1);assert.equal(visited.length,10);
  assert.equal(db.prepare('SELECT count(*) n FROM production_reviews WHERE id=?').get(receipt.id).n,1);assert.equal(db.prepare('SELECT count(*) n FROM production_review_assets WHERE review_id=?').get(receipt.id).n,10);
  assert.equal(db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);assert.equal((await ingestArchiveProduction(request,manifest,{resolver:real,reviewStore})).status,'DUPLICATE');
  real.release(retained.id,retained.scope);
 }}finally{real.close();db.close();}
});
test('full manifest scope and aggregate budgets are checked before transport or review mutation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-archive-preflight-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const out=join(root,'demo'),demo=await v3ArchiveDemo(out),request=JSON.parse(readFileSync(join(out,'archive-request.json'))),manifest=JSON.parse(readFileSync(demo.archive_manifest));let calls=0;
 const resolver={resolve(){calls++;throw Error('should not resolve');}},reviewStore={scope(){calls++;},ingest(){calls++;}};
 const wrong=structuredClone(manifest);wrong.items[1].files[0].archive.content_id=wrong.items[0].source_id;await assert.rejects(()=>ingestArchiveProduction(request,wrong,{resolver,reviewStore}),/SCOPE_DENIED/);
 const missing=structuredClone(manifest);missing.items[0].files.pop();await assert.rejects(()=>ingestArchiveProduction(request,missing,{resolver,reviewStore}),/MANIFEST_INVALID/);
 const budget=structuredClone(manifest);for(const item of budget.items)for(const file of item.files){file.archive.archive_size=128*1024*1024;file.archive.parts=[{index:0,file_id:file.archive.archive_file_id,bytes:file.archive.archive_size,sha256:file.archive.archive_sha256}];}
 await assert.rejects(()=>ingestArchiveProduction(request,budget,{resolver,reviewStore}),/BUDGET_EXCEEDED/);assert.equal(calls,0);
});
