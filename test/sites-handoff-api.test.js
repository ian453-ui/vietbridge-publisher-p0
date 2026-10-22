import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalFixture,syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
import {createCloudAuthoringApi} from '../src/sites/cloud-authoring-api.js';
test('approval and prepare HTTP routes require injected existing admin, exact commands and same origin',async t=>{
 const x=await approvalFixture(t),origin=x.f.origin;let authority=null;
 const api=createCloudAuthoringApi({db:x.f.db,bucket:x.bucket,origin,getTrustedIdentity:async()=>({userId:'synthetic-owner'}),resolveApprovalAuthority:async()=>authority});
 const base='/api/sites/workspaces/'+x.workspace,suffix='?accountId='+x.accountId,review=base+'/reviews/'+x.id;
 const call=async(path,body,headers={})=>{const r=await api(new Request(origin+path,{method:body?'POST':'GET',headers:{origin,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}));return {status:r.status,...await r.json()};};
 const v=await call(review+'/approval'+suffix);assert.equal(v.can_decide,false);const cmd=approvalCommand(v);
 assert.equal((await call(review+'/approval'+suffix,{...cmd,authenticated:true})).status,403);authority=syntheticAdmin;
 assert.equal((await call(review+'/approval'+suffix,cmd,{origin:'https://evil.invalid'})).status,403);assert.equal((await call(review+'/approval'+suffix,{...cmd,authenticated:true})).status,409);
 const a=await call(review+'/approval'+suffix,cmd);assert.equal(a.status,'RECORDED');assert.equal(a.publish_allowed,false);const plan=await call(review+'/prepare'+suffix,{source_id:x.packet.request.items[0].source_id,payload_artifact_id:'platform',expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id});assert.equal(plan.status,'UPLOAD_PREVIEW_ONLY');assert.equal(plan.job_state,'DRAFT');
 const contents=await call(base+'/contents'+suffix);assert.ok(contents.contents.find(c=>c.id===plan.content_id));const content=contents.contents.find(c=>c.id===plan.content_id);
 assert.equal((await call(base+'/tasks',{command_id:crypto.randomUUID(),account_id:x.accountId,content_id:content.id,expected_payload_hash:content.payload_hash})).error,'BOUND_REVIEW_TASK_REQUIRED');
 const second=(await call(base+'/accounts',{command_id:crypto.randomUUID(),display_name:'Other same-client FB',platform:'facebook',external_identity:null})).id;
 const shared=(await call(base+'/catalogue?accountId='+second)).contents.find(c=>c.id===content.id);assert.equal(shared.review_binding.plan_id,plan.id);assert.equal(shared.review_binding.account_id,x.accountId);assert.equal(shared.source_status,'MANUAL_UNVERIFIED');
 assert.equal((await call(base+'/tasks',{command_id:crypto.randomUUID(),account_id:second,content_id:content.id,expected_payload_hash:content.payload_hash,expected_platform:'facebook'})).error,'BOUND_REVIEW_TASK_REQUIRED');
 assert.ok((await call(review+'/approval?accountId='+second,approvalCommand(a.approval))).status>=400);assert.ok((await call(base+'/plans/'+plan.id+'?accountId='+second)).status>=400);assert.equal((await call(base+'/plans/'+plan.id+suffix)).status,'UPLOAD_PREVIEW_ONLY');
 // Fault injection: attach an existing plan after manual-source preflight, just
 // before the shared-task batch. The in-transaction NOT EXISTS must still deny.
 const manual=await call(base+'/contents',{command_id:crypto.randomUUID(),account_id:x.accountId,content_id:'SYNTHETIC-20261022-075',slug:'late-review-binding',revision:1,title:'Manual source',body:'Manual body',variants:{facebook:{title:'Manual FB',body:'Manual body'}}}),cmd2={command_id:crypto.randomUUID(),account_id:second,content_id:manual.id,expected_payload_hash:manual.payload_hash,expected_platform:'facebook'},batch=x.f.db.batch;let reached,release;const atBatch=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});x.f.db.batch=async statements=>{reached();await gate;return batch(statements);};const pending=call(base+'/tasks',cmd2);await atBatch;x.f.sql.prepare('UPDATE sites_upload_plans SET content_id=? WHERE id=?').run(manual.id,plan.id);release();assert.equal((await pending).error,'STORAGE_WRITE_REJECTED');assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_authoring_commands WHERE command_id=?').get(cmd2.command_id).n,0);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM publisher_jobs WHERE account_id=?').get(second).n,0);
 for(const action of ['execute','publish','upload'])assert.equal((await call(base+'/plans/'+plan.id+'/'+action+suffix,{confirm:true})).status,404);
});
