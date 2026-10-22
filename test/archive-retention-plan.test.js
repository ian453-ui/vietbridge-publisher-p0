import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveRetentionPlan} from '../src/archive-retention-plan.js';
const rows=(project,library)=>Array.from({length:25},(_,i)=>({project_id:project,library_id:library,file_id:'original-'+i,kind:'ORIGINAL_MEDIA',original_media_timestamp:new Date(Date.UTC(2026,8,i+1)).toISOString()}));
test('latest twenty originals are protected per project/library, while fresh ZIP/ledger timestamps cannot displace them',()=>{
 const inventory=[...rows('a','videos'),...rows('a','images'),...rows('b','videos')];
 for(const library_id of ['videos','images'])for(const kind of ['ARCHIVE','LEDGER'])inventory.push({project_id:'a',library_id,file_id:kind,kind,original_media_timestamp:'2026-10-22T00:00:00.000Z'});
 inventory[0].updated_at='2026-10-22T00:00:00.000Z';const before=JSON.stringify(inventory),plan=archiveRetentionPlan(inventory);
 assert.equal(plan.protected_files.length,60);assert.equal(plan.outside_latest20.length,15);assert.equal(JSON.stringify(inventory),before);
 assert.ok(plan.protected_files.every(x=>Number(x.file_id.slice(9))>=5));assert.deepEqual(plan.deletion_candidates,[]);assert.equal(plan.delete_allowed,false);assert.equal(plan.permanent_deletion_paused,true);
});

function withEvidence(row){
 const content_id='SYNTHETIC-FULL-074-TRADE',content_revision='v2',publication_targets=[{platform:'wechat_channels',account_id:'channels-fixture',job_id:'job-channel'},{platform:'xiaohongshu',account_id:'xhs-fixture',job_id:'job-xhs'}];
 return {...row,media_type:'VIDEO',content_id,content_revision,publication_targets,publication_evidence:publication_targets.map(target=>({...target,project_id:row.project_id,content_id,content_revision,status:'PUBLISHED',source:'LIVE_PLATFORM_READBACK',readback_verified:true,platform_object_id:'synthetic-object-'+target.platform,observed_at:'2026-10-21T00:00:00.000Z'}))};
}
test('only older videos with every declared target read back enter technical review; deletion remains paused',()=>{
 const inventory=rows('a','videos').map(withEvidence),plan=archiveRetentionPlan(inventory);assert.equal(plan.technical_candidates.length,5);assert.ok(plan.technical_candidates.every(x=>Number(x.file_id.slice(9))<5));assert.deepEqual(plan.deletion_candidates,[]);assert.equal(plan.delete_allowed,false);
 const images=inventory.map(r=>({...r,media_type:'IMAGE_TEXT'}));assert.deepEqual(archiveRetentionPlan(images).technical_candidates,[]);
});
test('missing/UNKNOWN/submit-only/test-only/wrong-account evidence and newer failed readback block candidate status',()=>{
 for(const mutate of [r=>r.publication_evidence.pop(),r=>r.publication_evidence[1].status='UNKNOWN',r=>r.publication_evidence[1].source='SUBMIT_CLICK',r=>r.publication_evidence[1].source='SYNTHETIC_TEST',r=>r.publication_evidence[1].account_id='other',r=>r.publication_evidence[1].content_revision='v1',r=>r.publication_targets=[],r=>r.publication_evidence.push({...r.publication_evidence[1],observed_at:'2026-10-22T00:00:00.000Z',status:'UNKNOWN'})]){
  const inventory=rows('a','videos');inventory[0]=withEvidence(inventory[0]);mutate(inventory[0]);assert.deepEqual(archiveRetentionPlan(inventory).technical_candidates,[]);
 }
});
test('uncertain original timestamp protects the whole library; cutoff ties retain more than twenty',()=>{
 const uncertain=rows('a','one');uncertain[0].original_media_timestamp=null;assert.equal(archiveRetentionPlan(uncertain).protected_files.length,25);
 const tied=rows('a','one');tied[4].original_media_timestamp=tied[5].original_media_timestamp;assert.equal(archiveRetentionPlan(tied).protected_files.length,21);
 assert.equal(archiveRetentionPlan(rows('a','one').slice(0,3)).protected_files.length,3);
});
test('missing scope and duplicated identity reject; identical file IDs in separate projects remain separate',()=>{
 assert.throws(()=>archiveRetentionPlan([{...rows('a','one')[0],library_id:''}]),/INVALID/);
 const one=rows('a','one')[0];assert.throws(()=>archiveRetentionPlan([one,one]),/DUPLICATE/);
 assert.equal(archiveRetentionPlan([one,{...one,project_id:'b'}]).protected_files.length,2);
});
