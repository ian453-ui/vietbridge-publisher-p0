import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {sitesEvidenceFixture,fileBucket,inspectedPacket} from './fixtures/sites-evidence.js';
import {createCloudAuthoringApi} from '../src/sites/cloud-authoring-api.js';
import {AsyncReviewStore} from '../src/sites/async-review-store.js';
import {AsyncMetricStore} from '../src/sites/async-metric-store.js';
import {metricPacket,metricNow} from './fixtures/synthetic-metrics.js';

test('Sites evidence reads bind trusted owner/account, exact asset bytes and immutable source state; write routes absent',async t=>{
 const f=await sitesEvidenceFixture(t),bucket=fileBucket(join(f.root,'objects')),packet=inspectedPacket(f.root,f.scope),store=new AsyncReviewStore(f.f.db,{bucket,inspectionProvider:{readInspection:async()=>packet}}),r=await store.intake({...f.scope,task_id:packet.request.task_id,request_revision:1}),metrics=new AsyncMetricStore(f.f.db),id=(await metrics.registerTarget(f.target)).id,metric=await metrics.ingest(id,metricPacket(f.target),{...f.scope,now:metricNow});let user='synthetic-owner';
 const origin='https://synthetic.invalid',api=createCloudAuthoringApi({db:f.f.db,bucket,origin,getTrustedIdentity:async()=>user?{userId:user}:null}),base='/api/sites/workspaces/'+f.workspace,suffix='?accountId='+f.accountId,call=(path,method='GET',body)=>api(new Request(origin+base+path,{method,headers:{origin,'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},...(body?{body:JSON.stringify(body)}:{})}));
 assert.equal((await call('/reviews'+suffix)).status,200);assert.equal((await(await call('/reviews/'+r.id+suffix)).json()).can_decide,false);assert.equal((await(await call('/metrics/'+metric.series_id+suffix)).json()).value,100);assert.equal((await call('/metrics/'+metric.series_id+'/history'+suffix)).status,200);
 const path='/reviews/'+r.id+'/assets/'+packet.assets[0].source_id+'/'+packet.assets[0].artifact_id+suffix,asset=await call(path);assert.equal(asset.status,200);assert.equal(asset.headers.get('X-Content-Type-Options'),'nosniff');assert.deepEqual(Buffer.from(await asset.arrayBuffer()),Buffer.from(packet.assets[0].data));
 for(const p of ['/reviews','/reviews/'+r.id,'/metrics','/metrics/'+metric.series_id])assert.equal((await call(p+suffix,'POST',{authenticated:true,decision:'APPROVE'})).status,405);
 const otherAccount=(await f.post(base+'/accounts',{display_name:'Other account',platform:'facebook',external_identity:null})).id;assert.equal((await call(path.replace(f.accountId,otherAccount))).status,404);
 user='intruder';assert.equal((await call('/reviews'+suffix)).status,403);assert.equal((await call('/metrics'+suffix)).status,403);user=null;assert.equal((await call(path)).status,401);user='synthetic-owner';f.f.sql.prepare('UPDATE sites_project_memberships SET revoked_at=? WHERE account_id=?').run(new Date().toISOString(),f.accountId);assert.equal((await call(path)).status,403);
 assert.equal(f.f.sql.prepare("SELECT count(*) n FROM publisher_jobs WHERE state<>'DRAFT'").get().n,0);
});
