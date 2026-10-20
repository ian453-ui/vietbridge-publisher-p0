import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseAccountCapability,capabilityDimensions} from '../src/account-capability-facts.js';
const now=Date.parse('2026-10-20T12:00:00.000Z');
function fixture(){
 const scope={workspace:'workspace-fixture',account_id:'account-fixture',platform:'facebook',app_id:'app-fixture',action:'publish',operation:'PAGE_POST_PUBLISH',transport:'BROWSER',build_sha:'a'.repeat(40)};
 return {scope,frozen_scope:{...scope},job_state:'READY',submit_safety_domain:'BEFORE_EXTERNAL_SUBMIT',evidence:Object.entries(capabilityDimensions).map(([dimension,kind])=>({dimension,status:'VERIFIED',scope:{...scope},observed_at:'2026-10-20T11:00:00.000Z',valid_until:'2026-10-20T13:00:00.000Z',source:{kind,reference:dimension==='platform_support'?'https://example.invalid/synthetic-official-reference':'fixture-'+dimension}}))};
}
const check=x=>diagnoseAccountCapability(x,{now});
test('all separately verified dimensions yield evidence completeness, never authority',()=>{
 const x=fixture(),before=JSON.stringify(x),r=check(x);assert.equal(r.status,'EVIDENCE_COMPLETE');assert.equal(r.can_execute,false);assert.equal(r.owner_changed,false);assert.equal(JSON.stringify(x),before);assert.equal(Object.keys(r.facts).length,7);
});
test('missing permissions, unknown/not-verified or denied evidence cannot imply support',()=>{
 for(const dimension of Object.keys(capabilityDimensions)){
  const missing=fixture();missing.evidence=missing.evidence.filter(e=>e.dimension!==dimension);assert.equal(check(missing).facts[dimension].status,'BLOCKED');
  for(const status of ['UNKNOWN','NOT_VERIFIED','UNSUPPORTED','DENIED']){const x=fixture();x.evidence.find(e=>e.dimension===dimension).status=status;assert.equal(check(x).status,'BLOCKED');}
 }
});
test('stale, future, malformed or wrong-kind evidence cannot substitute for current verification',()=>{
 for(const change of [e=>e.valid_until='2026-10-20T12:00:00.000Z',e=>e.observed_at='2026-10-20T12:30:00.000Z',e=>e.valid_until='bad',e=>e.source.kind='CODE_REVIEW']){const x=fixture();change(x.evidence[0]);assert.equal(check(x).facts.platform_support.status,'BLOCKED');}
});
test('evidence cannot cross account/app/action/operation/transport/build boundaries',()=>{
 for(const key of ['workspace','account_id','app_id','action','operation','transport','build_sha']){
  const x=fixture();x.evidence[1].scope[key]=key==='action'?'reply':key==='build_sha'?'b'.repeat(40):'other';assert.ok(check(x).facts.app_approval.reasons.includes('EVIDENCE_SCOPE_MISMATCH'),key);
 }
 const x=fixture();x.scope.transport='API';assert.ok(check(x).reasons.includes('FROZEN_SCOPE_CHANGED'));
});
test('unknown/executed results require readback, but readback diagnosis does not authorize retries',()=>{
 for(const job_state of ['UNKNOWN','RECONCILE_PENDING','SUBMITTING','PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_WRITTEN']){const x=fixture();x.job_state=job_state;assert.ok(check(x).reasons.includes('EXISTING_OR_UNCERTAIN_RESULT_REQUIRES_READBACK'));}
 const x=fixture();x.submit_safety_domain='MAY_HAVE_SUBMITTED';assert.equal(check(x).status,'BLOCKED');
 x.scope.action=x.frozen_scope.action='readback';for(const e of x.evidence)e.scope.action='readback';assert.equal(check(x).status,'EVIDENCE_COMPLETE');assert.equal(check(x).can_execute,false);
});
test('existing registry is reused; no new platform or transport is inferred from evidence',()=>{
 const x=fixture();x.scope.platform=x.frozen_scope.platform='tiktok';for(const e of x.evidence)e.scope.platform='tiktok';assert.ok(check(x).reasons.includes('LOCAL_PLATFORM_NOT_REGISTERED'));
 const y=fixture();y.scope.transport=y.frozen_scope.transport='UNATTENDED_SDK';for(const e of y.evidence)e.scope.transport='UNATTENDED_SDK';assert.ok(check(y).reasons.includes('LOCAL_TRANSPORT_NOT_REGISTERED'));
});
test('draft evidence cannot prove public publication or broadcast and conflicting duplicate facts reject',()=>{
 const x=fixture();x.scope.platform=x.frozen_scope.platform='wechat_official_account';x.scope.transport=x.frozen_scope.transport='API';x.scope.operation=x.frozen_scope.operation='PUBLIC_PUBLICATION';
 for(const e of x.evidence){e.scope={...x.scope,operation:'DRAFT_WRITE'};}
 assert.equal(check(x).status,'BLOCKED');
 const y=fixture();y.evidence.push(structuredClone(y.evidence[0]));assert.throws(()=>check(y),/DUPLICATE_CAPABILITY_DIMENSION/);
});

import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
test('local CLI reports without mutation and rejects duplicate JSON or credential-bearing documentation URLs',()=>{
 const root=mkdtempSync(join(tmpdir(),'capability-facts-')),file=join(root,'input.json'),cli=new URL('../scripts/check-account-capability.mjs',import.meta.url).pathname;
 try{
  const x=fixture(),at=Date.now();for(const e of x.evidence){e.observed_at=new Date(at-10000).toISOString();e.valid_until=new Date(at+60000).toISOString();}
  const raw=JSON.stringify(x);writeFileSync(file,raw);const r=spawnSync(process.execPath,[cli,file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'EVIDENCE_COMPLETE');assert.equal(JSON.parse(r.stdout).can_execute,false);assert.equal(readFileSync(file,'utf8'),raw);
  writeFileSync(file,'{"scope":{},"scope":{}}');const bad=spawnSync(process.execPath,[cli,file],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/DUPLICATE_JSON_KEY/);
  x.evidence[0].source.reference='https://user:secret@example.invalid/document';assert.ok(diagnoseAccountCapability(x,{now:at}).facts.platform_support.reasons.includes('OFFICIAL_SOURCE_REFERENCE_REQUIRED'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
