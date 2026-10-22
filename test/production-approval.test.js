import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {v3ReviewDemo} from '../scripts/v3-review-demo.mjs';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {createProductionRequest,packageProductionResult,productionItemFingerprint} from '../src/production-artifact-contract.js';
import {seedSyntheticApproval,approvalCommand,syntheticAdmin} from './fixtures/synthetic-approval.js';
const syntheticPng=()=>execFileSync('python3',['-I','-B','-c','from PIL import Image; import sys; Image.new("RGB",(320,240),"red").save(sys.stdout.buffer,"PNG")'],{timeout:5000,maxBuffer:1024*1024});

function setup(t,{provenance=true}={}){
 const root=mkdtempSync(join(tmpdir(),'v3-approval-')),out=join(root,'demo'),demo=v3ReviewDemo(out),db=new DatabaseSync(demo.dbPath),reviews=new ProductionReviewStore(db),scope={workspace:demo.workspace,accountId:demo.accountId};t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 if(provenance)seedSyntheticApproval(reviews,demo.id,scope);const approvals=reviews.approvals,view=()=>approvals.view(demo.id,scope,{admin:true}),decide=command=>approvals.decide(demo.id,command,scope,{authority:syntheticAdmin});return {root,out,demo,db,reviews,scope,approvals,view,decide};
}
test('explicit approval/rejection persist, repeats are idempotent and audit survives restart without publishing',t=>{
 const f=setup(t),command=approvalCommand(f.view()),receipt=f.decide(command);assert.equal(receipt.status,'RECORDED');assert.equal(receipt.approval.state,'CONTENT_APPROVED');assert.equal(receipt.publish_allowed,false);assert.equal(receipt.source_gate_satisfied,false);
 assert.equal(f.decide(command).status,'DUPLICATE');assert.equal(f.decide(approvalCommand(f.view())).status,'DUPLICATE');assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,1);
 const reject=approvalCommand(f.view(),{decision:'REJECT',reason:'Synthetic visual issue'});assert.equal(f.decide(reject).approval.state,'CONTENT_REJECTED');assert.equal(f.decide(command).approval.state,'CONTENT_REJECTED','replayed old command cannot reapprove');
 const db=new DatabaseSync(f.demo.dbPath);try{const persisted=new ProductionReviewStore(db).approvals.view(f.demo.id,f.scope,{admin:true});assert.equal(persisted.state,'CONTENT_REJECTED');assert.equal(persisted.history.length,2);}finally{db.close();}
 assert.equal(f.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);assert.throws(()=>f.db.exec("UPDATE production_approval_events SET kind='CONTENT_APPROVED'"),/AUDIT_IMMUTABLE/);
});
test('admin, exact scope, explicit checklist, current event and trusted fixture provenance are required',t=>{
 const f=setup(t),command=approvalCommand(f.view());assert.throws(()=>f.approvals.decide(f.demo.id,command,f.scope),/ADMIN_REQUIRED/);assert.throws(()=>f.approvals.decide(f.demo.id,command,{workspace:f.demo.otherWorkspace,accountId:f.demo.otherAccountId},{authority:syntheticAdmin}),/NOT_FOUND/);
 const unchecked=structuredClone(command);unchecked.checks.VISUAL_QA=false;assert.throws(()=>f.decide(unchecked),/CHECKLIST_REQUIRED/);assert.throws(()=>f.decide({...command,producer_authenticated:true}),/COMMAND_INVALID/);
 f.decide(command);assert.throws(()=>f.decide({...approvalCommand(f.view(),{decision:'REJECT'}),expected_event_id:null}),/STALE_DECISION/);assert.throws(()=>f.decide({...command,reason:'changed'}),/COMMAND_CONFLICT/);
 const unknown=setup(t,{provenance:false});assert.equal(unknown.view().can_decide,false);assert.equal(unknown.view().blocked_reason,'PRODUCER_AUTH_UNAVAILABLE');assert.throws(()=>unknown.decide(approvalCommand(unknown.view())),/PRODUCER_AUTH_UNAVAILABLE/);
 f.db.prepare("UPDATE records SET value=json_set(value,'$.library_kind','enterprise') WHERE kind='workspaces' AND id=?").run(f.demo.workspace);assert.equal(f.view().state,'REVOKED');assert.throws(()=>f.decide(approvalCommand(f.view())),/ENTERPRISE_SOURCE_APPROVAL_FORBIDDEN/);
});
function revised(f,kind){
 const old=JSON.parse(readFileSync(join(f.out,'request.json'))),{request_fingerprint,assignment_mode,handoff_policy,...plan}=structuredClone(old);plan.request_revision++;const item=plan.items[0];item.previous_revision=productionItemFingerprint(old.items[0]);
 if(kind==='image'){item.visual_revision++;writeFileSync(join(f.demo.artifactRoot,item.source_id,'cover.png'),syntheticPng());}
 else{item.content_revision++;if(kind==='body')writeFileSync(join(f.demo.artifactRoot,item.source_id,'article.md'),'# Revised synthetic article\nDifferent reviewed bytes.');if(kind==='platform')item.deliverables.find(x=>x.kind==='platform_payload').platform='xiaohongshu';if(kind==='source')item.source_refs=[{source_id:'SYNTHETIC-SOURCE',revision:'v2',sha256:'b'.repeat(64)}];}
 const request=createProductionRequest(plan,{priorRequest:old}),selections=JSON.parse(readFileSync(join(f.out,'production/selections.json'))),result=packageProductionResult(request,selections,{root:f.demo.artifactRoot});return {request,result};
}
test('new body/image/platform/source versions atomically revoke the old approval and require fresh review',t=>{
 for(const kind of ['body','image','platform','source']){
  const f=setup(t),command=approvalCommand(f.view());f.decide(command);const {request,result}=revised(f,kind),receipt=f.reviews.ingest(request,result,{root:f.demo.artifactRoot});
  assert.equal(f.view().state,'REVOKED');assert.throws(()=>f.decide(command),/STALE_REVIEW_VERSION/);seedSyntheticApproval(f.reviews,receipt.id,f.scope);assert.equal(f.approvals.view(receipt.id,f.scope,{admin:true}).state,'PENDING');
  const state=f.approvals.view(receipt.id,f.scope,{admin:true});assert.notEqual(state.subject_fingerprint,command.expected_subject);assert.throws(()=>f.approvals.decide(receipt.id,{...approvalCommand(state),expected_subject:command.expected_subject},f.scope,{authority:syntheticAdmin}),/STALE_SUBJECT/);assert.equal(f.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
 }
});
test('changed account target or corrupted/UNKNOWN evidence invalidates prior approval instead of inheriting it',t=>{
 for(const change of ['identity','platform','bytes','unknown']){
  const f=setup(t);f.decide(approvalCommand(f.view()));
  if(change==='identity')f.db.prepare('UPDATE facebook_accounts SET target_page_id=? WHERE id=?').run('900000000000099',f.demo.accountId);
  if(change==='platform')f.db.prepare("UPDATE facebook_accounts SET platform='xiaohongshu' WHERE id=?").run(f.demo.accountId);
  if(change==='bytes')f.db.prepare("UPDATE production_review_assets SET data=? WHERE review_id=? AND artifact_id='article'").run(Buffer.from('changed'),f.demo.id);
  if(change==='unknown')f.db.prepare("UPDATE production_reviews SET report_json='{}' WHERE id=?").run(f.demo.id);
  const view=f.view();assert.equal(view.state,'REVOKED');assert.equal(view.can_decide,false);assert.equal(view.history[0].kind,'REVOKED');assert.throws(()=>f.decide({...approvalCommand(view),expected_subject:'a'.repeat(64)}));
 }
});
test('receipt insertion failure rolls back its decision; failed new intake preserves existing approval',t=>{
 const f=setup(t),command=approvalCommand(f.view());f.db.exec("CREATE TEMP TRIGGER fail_approval_receipt BEFORE INSERT ON production_approval_commands BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RECEIPT_FAILURE'); END");assert.throws(()=>f.decide(command),/RECEIPT_FAILURE/);assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,0);f.db.exec('DROP TRIGGER fail_approval_receipt');f.decide(command);
 const {request,result}=revised(f,'body');f.db.exec("CREATE TEMP TRIGGER fail_new_asset BEFORE INSERT ON production_review_assets BEGIN SELECT RAISE(ABORT,'SYNTHETIC_NEW_ASSET_FAILURE'); END");assert.throws(()=>f.reviews.ingest(request,result,{root:f.demo.artifactRoot}),/NEW_ASSET_FAILURE/);assert.equal(f.view().state,'CONTENT_APPROVED');assert.equal(f.db.prepare('SELECT count(*) n FROM production_review_envelopes').get().n,1);
 f.db.exec("DROP TRIGGER fail_new_asset; CREATE TEMP TRIGGER fail_revocation BEFORE INSERT ON production_approval_events WHEN NEW.kind='REVOKED' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REVOCATION_FAILURE'); END");assert.throws(()=>f.reviews.ingest(request,result,{root:f.demo.artifactRoot}),/REVOCATION_FAILURE/);assert.equal(f.view().state,'CONTENT_APPROVED');assert.equal(f.db.prepare('SELECT count(*) n FROM production_review_envelopes').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM production_review_assets').get().n,10);
});
test('two processes approving the same subject create one decision and two idempotent command receipts',async t=>{
 const f=setup(t),input={id:f.demo.id,scope:f.scope,authority:syntheticAdmin,command:approvalCommand(f.view())},file=join(f.root,'command.json'),gate=join(f.root,'go');writeFileSync(file,JSON.stringify(input));
 const code=`import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {ProductionApprovalStore} from './src/production-approval-store.js';const [path,dbPath,gate,ready]=process.argv.slice(1),x=JSON.parse(readFileSync(path));x.command.command_id=randomUUID();const db=new DatabaseSync(dbPath);db.exec('PRAGMA busy_timeout=3000');const s=new ProductionApprovalStore(db);writeFileSync(ready,'ready');while(!existsSync(gate))await new Promise(r=>setTimeout(r,5));try{console.log(JSON.stringify(s.decide(x.id,x.command,x.scope,{authority:x.authority})));}finally{db.close();}`;
 const run=promisify(execFile),jobs=[0,1].map(i=>run(process.execPath,['--input-type=module','-e',code,file,f.demo.dbPath,gate,join(f.root,i+'.ready')],{timeout:15000}));const until=Date.now()+5000;while(![0,1].every(i=>existsSync(join(f.root,i+'.ready')))&&Date.now()<until)await new Promise(r=>setTimeout(r,10));writeFileSync(gate,'go');assert.deepEqual((await Promise.all(jobs)).map(x=>JSON.parse(x.stdout).status).sort(),['DUPLICATE','RECORDED']);assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM production_approval_commands').get().n,2);
});
