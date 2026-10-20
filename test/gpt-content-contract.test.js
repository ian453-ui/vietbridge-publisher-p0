import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGptContentRequest,inspectGptContentResult,bindGptResultToInbox} from '../src/gpt-content-contract.js';
import {readGptDriveInbox} from '../src/gpt-drive-inbox.js';
const now=Date.parse('2026-10-20T10:30:00.000Z');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function input(){return {schema_version:1,task_id:'EXISTING-TASK-001',request_revision:1,current_owner:'MAC_CODEX',producer:'GPT',workspace:'client-fixture',account_id:'account-fixture',source_id:'FIXTURE-001',content_revision:1,visual_revision:1,previous_revision:null,created_at:'2026-10-20T10:00:00.000Z',deadline_at:'2026-10-20T11:00:00.000Z',bridge_ref:{marker:'bridge-task:v1',protocol_version:'2.0',transport:'SLACK_FIRST',slack_channel_id:'C0C6PRGNGLQ',thread_ts:'1792490400.000001'},input:{kind:'image_text',platform:'facebook',brief:'Synthetic fictional client post; no live publishing.',language:'zh-CN',source_refs:[{source_id:'SOURCE-001',revision:'r1',sha256:'a'.repeat(64)}]}};}
function response(request,image='b'.repeat(64)){return {...Object.fromEntries(['schema_version','task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id','source_id','content_revision','visual_revision','bridge_ref'].map(k=>[k,request[k]])),completed_at:'2026-10-20T10:20:00.000Z',status:'SUCCEEDED',output:{title:'Fictional title',facebook_caption:'Fictional body for isolated tests.',primary_image_sha256:image},error_code:null};}
test('request fingerprint is deterministic across key order and binds every input revision',()=>{
 const x=input(),r=createGptContentRequest(x),before=JSON.stringify(x);
 const reversed=Object.fromEntries(Object.entries(x).reverse());reversed.input=Object.fromEntries(Object.entries(x.input).reverse());
 assert.equal(createGptContentRequest(reversed).request_fingerprint,r.request_fingerprint);
 for(const change of [x=>x.input.brief+=' changed',x=>x.input.source_refs[0].sha256='c'.repeat(64),x=>x.request_revision++,x=>x.visual_revision++,x=>x.account_id='other',x=>x.current_owner='GPT']){const y=structuredClone(x);change(y);assert.notEqual(createGptContentRequest(y).request_fingerprint,r.request_fingerprint);}
 assert.equal(JSON.stringify(x),before);assert.equal(r.current_owner,'MAC_CODEX');assert.equal(r.producer,'GPT');assert.equal(r.assignment_mode,'STICKY');
});
test('invalid schemas, unsupported platforms and malformed versions fail before creating a request',()=>{
 for(const change of [x=>x.schema_version=2,x=>x.producer='other',x=>x.input.platform='tiktok',x=>x.input.kind='video',x=>x.content_revision=0,x=>x.previous_revision='not-a-hash',x=>x.input.source_refs[0].extra=true,x=>x.deadline_at=x.created_at]){const x=input();change(x);assert.throws(()=>createGptContentRequest(x));}
});
test('result must retain task, owner, assigned GPT, account and exact request version',()=>{
 const r=createGptContentRequest(input());
 for(const key of ['task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id','source_id','content_revision','visual_revision']){const x=response(r);x[key]='wrong';assert.throws(()=>inspectGptContentResult(r,x,{now}),/RESULT_BINDING_MISMATCH/,key);}
 const forged=structuredClone(r);forged.input.brief+=' changed';assert.throws(()=>inspectGptContentResult(forged,response(r),{now}),/REQUEST_FINGERPRINT_MISMATCH/);
});
test('success stays review-only; duplicate result is idempotent, conflicting and stale results rejected',()=>{
 const r=createGptContentRequest(input()),x=response(r),first=inspectGptContentResult(r,x,{now});assert.equal(first.status,'REVIEW_REQUIRED');assert.equal(first.publish_allowed,false);
 assert.equal(inspectGptContentResult(r,x,{now:now+7200000,priorReceipt:first.receipt}).status,'DUPLICATE');
 const changed=structuredClone(x);changed.output.facebook_caption+=' changed';assert.throws(()=>inspectGptContentResult(r,changed,{now,priorReceipt:first.receipt}),/CONFLICTING_RESULT/);
 assert.throws(()=>inspectGptContentResult(r,x,{now:Date.parse(r.deadline_at)}),/RESULT_EXPIRED/);
 const revised=input();revised.request_revision++;assert.throws(()=>inspectGptContentResult(createGptContentRequest(revised),x,{now}),/RESULT_BINDING_MISMATCH/);
 x.completed_at='2026-10-20T10:31:00.000Z';assert.throws(()=>inspectGptContentResult(r,x,{now}),/INVALID_RESULT_TIME/);
});
test('failure and cancellation are explicit, cannot carry successful artifacts or trigger retry',()=>{
 const r=createGptContentRequest(input());
 for(const status of ['FAILED','CANCELLED']){const x={...response(r),status,output:null,error_code:'PRODUCER_FAILED'};const checked=inspectGptContentResult(r,x,{now});assert.equal(checked.status,status);assert.equal(checked.publish_allowed,false);assert.equal(checked.output,undefined);x.output=response(r).output;assert.throws(()=>inspectGptContentResult(r,x,{now}),/INVALID_FAILURE_RESULT/);}
});
test('real existing inbox hashes bind result to pending QA without approving or writing manifest',()=>{
 const root=mkdtempSync(join(tmpdir(),'gpt-contract-'));
 try{
  const folder=join(root,'GPT-INBOX','request-1');mkdirSync(folder,{recursive:true});
  const image=readFileSync(new URL('./fixtures/gpt-primary.png',import.meta.url)),r=createGptContentRequest(input()),x=response(r,sha(image));
  const submission={schema_version:1,status:'READY_FOR_REVIEW',content_id:r.source_id,title:x.output.title,facebook_caption:x.output.facebook_caption,primary_image:'primary.png',revision_number:1,visual_revision:1,primary_image_sha256:sha(image)};
  writeFileSync(join(folder,'primary.png'),image);writeFileSync(join(folder,'submission.json'),JSON.stringify(submission));
  const manifest={status:'READY',items:[]};writeFileSync(join(root,'publisher-manifest.json'),JSON.stringify(manifest));
  const before=readFileSync(join(root,'publisher-manifest.json')),candidate=readGptDriveInbox(root,manifest)[0],context={workspace:r.workspace,account_id:r.account_id};
  const bound=bindGptResultToInbox(r,x,candidate,context,{now});assert.equal(bound.status,'REVIEW_REQUIRED');assert.equal(bound.publish_allowed,false);assert.equal(bound.owner_changed,false);assert.equal(bound.qa_binding.inbox_revision,candidate.revision);assert.ok(bound.required_review.includes('IMAGE_VISUAL_QA'));
  assert.deepEqual(readFileSync(join(root,'publisher-manifest.json')),before);assert.deepEqual(readFileSync(join(folder,'primary.png')),image);
  assert.throws(()=>bindGptResultToInbox(r,x,candidate,{...context,account_id:'other'},{now}),/INBOX_SCOPE_MISMATCH/);
  for(const changed of [{...candidate,body:'changed'},{...candidate,revisionNumber:2},{...candidate,previousRevision:'c'.repeat(64)},{...candidate,reviewStatus:'INVALID'},{...candidate,ready:true}])assert.throws(()=>bindGptResultToInbox(r,x,changed,context,{now}));
  writeFileSync(join(folder,'primary.png'),Buffer.alloc(512,99));assert.throws(()=>bindGptResultToInbox(r,x,readGptDriveInbox(root,manifest)[0],context,{now}),/INBOX_NOT_PENDING_REVIEW/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('same task revision cannot be changed, older requests and automatic owner/thread transfer rejected',()=>{
 const x=input(),r=createGptContentRequest(x);
 assert.deepEqual(createGptContentRequest(x,{priorRequest:r}),r);
 const changed=structuredClone(x);changed.input.brief+=' changed';assert.throws(()=>createGptContentRequest(changed,{priorRequest:r}),/REQUEST_REVISION_CONFLICT/);
 changed.request_revision=2;const next=createGptContentRequest(changed,{priorRequest:r});assert.throws(()=>createGptContentRequest(x,{priorRequest:next}),/STALE_REQUEST/);
 for(const key of ['current_owner','workspace','account_id']){const wrong=structuredClone(changed);wrong[key]=key==='current_owner'?'GPT':'other';assert.throws(()=>createGptContentRequest(wrong,{priorRequest:r}),/REQUEST_IDENTITY_CHANGE/);}
 changed.bridge_ref.thread_ts='1792490400.000002';assert.throws(()=>createGptContentRequest(changed,{priorRequest:r}),/REQUEST_THREAD_CHANGE/);
 const returned=response(r);returned.bridge_ref={...r.bridge_ref,thread_ts:'1792490400.000002'};assert.throws(()=>inspectGptContentResult(r,returned,{now}),/RESULT_THREAD_MISMATCH/);
});
test('bridge owner registry is exact and legacy aliases are not silently reassigned',()=>{
 for(const current_owner of ['CODEX','CLOUD_CODEX','DOT','Dot','unknown']){const x=input();x.current_owner=current_owner;assert.throws(()=>createGptContentRequest(x),/INVALID_BRIDGE_REFERENCE/);}
 const x=input();x.current_owner='dot';assert.equal(createGptContentRequest(x).current_owner,'dot');
});
test('existing inbox rejects traversal and missing images before result binding',()=>{
 const root=mkdtempSync(join(tmpdir(),'gpt-path-contract-'));
 try{
  const folder=join(root,'GPT-INBOX','request-1');mkdirSync(folder,{recursive:true});const r=createGptContentRequest(input());
  const image=readFileSync(new URL('./fixtures/gpt-primary.png',import.meta.url)),x=response(r,sha(image));writeFileSync(join(root,'GPT-INBOX','outside.png'),image);
  for(const primary_image of ['../outside.png','missing.png']){
   writeFileSync(join(folder,'submission.json'),JSON.stringify({schema_version:1,status:'READY_FOR_REVIEW',content_id:r.source_id,title:x.output.title,facebook_caption:x.output.facebook_caption,primary_image}));
   const candidate=readGptDriveInbox(root,{status:'READY',items:[]})[0];assert.equal(candidate.reviewStatus,'INVALID');assert.throws(()=>bindGptResultToInbox(r,x,candidate,{workspace:r.workspace,account_id:r.account_id},{now}),/INBOX_NOT_PENDING_REVIEW/);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

import {spawnSync} from 'node:child_process';
test('CLI exports and inspects local manifests only, with sanitized failures',()=>{
 const root=mkdtempSync(join(tmpdir(),'gpt-cli-contract-'));
 try{
  const source=join(root,'input.json'),requestFile=join(root,'request.json'),resultFile=join(root,'result.json');
  const x=input(),timestamp=Date.now();x.created_at=new Date(timestamp-60000).toISOString();x.deadline_at=new Date(timestamp+60000).toISOString();writeFileSync(source,JSON.stringify(x));
  const cli=new URL('../scripts/gpt-content-contract.mjs',import.meta.url).pathname;
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
  const made=run('request',source);assert.equal(made.status,0,made.stderr);const request=JSON.parse(made.stdout);writeFileSync(requestFile,made.stdout);
  const r=response(request);r.completed_at=new Date(timestamp-1000).toISOString();writeFileSync(resultFile,JSON.stringify(r));
  const inspected=run('inspect',requestFile,resultFile);assert.equal(inspected.status,0,inspected.stderr);assert.equal(JSON.parse(inspected.stdout).status,'REVIEW_REQUIRED');
  assert.equal(readFileSync(source,'utf8'),JSON.stringify(x));assert.equal(readFileSync(resultFile,'utf8'),JSON.stringify(r));
  writeFileSync(resultFile,'synthetic-sensitive-invalid-json');const invalid=run('inspect',requestFile,resultFile);assert.equal(invalid.status,1);assert.ok(!invalid.stderr.includes('synthetic-sensitive'));assert.match(invalid.stderr,/INVALID_FILE_OR_JSON/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('prior bridge JSON property order is equivalent, actual thread changes still reject',()=>{
 const x=input(),prior=createGptContentRequest(x);
 prior.bridge_ref=Object.fromEntries(Object.entries(prior.bridge_ref).reverse());
 assert.deepEqual(createGptContentRequest(x,{priorRequest:prior}),createGptContentRequest(x));
 const next=structuredClone(x);next.request_revision++;assert.equal(createGptContentRequest(next,{priorRequest:prior}).request_revision,2);
 next.bridge_ref.thread_ts='1792490400.000002';assert.throws(()=>createGptContentRequest(next,{priorRequest:prior}),/REQUEST_THREAD_CHANGE/);
});

import {parseStrictJson} from '../src/strict-json.js';
test('strict JSON rejects repeated decoded keys at every nesting level, preserves valid JSON',()=>{
 for(const text of ['{"owner":"GPT","owner":"MAC_CODEX"}','{"input":{"brief":"a","brief":"a"}}','[{"a":1,"\\u0061":2}]'])assert.throws(()=>parseStrictJson(text),/DUPLICATE_JSON_KEY/);
 for(const text of ['{"a":[1,true,null,{"b":"escaped \\\" key"}],"c":-1.2e3}','[{"same":1},{"same":2}]','"text"','null','42'])assert.deepEqual(parseStrictJson(text),JSON.parse(text));
 assert.throws(()=>parseStrictJson('{bad'));
 assert.throws(()=>parseStrictJson('['.repeat(130)+'0'+']'.repeat(130)),/JSON_NESTING_LIMIT/);
});
test('CLI rejects duplicate JSON keys instead of selecting the last owner or input',()=>{
 const root=mkdtempSync(join(tmpdir(),'gpt-duplicate-json-')),file=join(root,'input.json');
 try{
  const raw=JSON.stringify(input()).replace('"current_owner":"MAC_CODEX"','"current_owner":"GPT","current_owner":"MAC_CODEX"');writeFileSync(file,raw);
  const result=spawnSync(process.execPath,[new URL('../scripts/gpt-content-contract.mjs',import.meta.url).pathname,'request',file],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/DUPLICATE_JSON_KEY/);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('MAC_CODEX'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
