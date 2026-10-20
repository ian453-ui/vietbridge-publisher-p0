import test from 'node:test';
import assert from 'node:assert/strict';
import {continuationReadiness} from '../src/continuation-readiness.js';
const now=Date.parse('2026-10-20T09:00:00Z'),commit='a'.repeat(40);
const source={repository:'https://github.com/ian453-ui/vietbridge-publisher-p0.git',branch:'publisher-unified',commit,clean:true};
function fixture(){return {version:1,originalOwner:'owner-fixture',currentOwner:'owner-fixture',targetCommit:commit,workspace:'workspace-fixture',accountId:'account-fixture',mac:{online:false,worktreeClean:true,preserveDataAndConfig:true,commit,localDependenciesVerified:true,observedAt:'2026-10-20T08:59:00Z',validUntil:'2026-10-20T09:01:00Z'},history:{complete:true,observedAt:'2026-10-20T08:59:00Z',validUntil:'2026-10-20T09:01:00Z',jobs:[]}};}
const check=(input,observed=source)=>continuationReadiness(input,observed,{now});
test('offline Mac blocks only Mac steps, not independent cloud work; no authority is issued',()=>{
 const input=fixture(),before=JSON.stringify(input),r=check(input);
 assert.equal(r.steps.cloudReviewBuildTest.status,'CHECKABLE');assert.equal(r.steps.macManualSync.status,'BLOCKED');assert.equal(r.steps.publication.status,'BLOCKED');
 assert.equal(r.ownerChanged,false);assert.equal(r.advisoryOnly,true);assert.equal(JSON.stringify(input),before);
});
test('owner changes and wrong source never become fallback continuation',()=>{
 const f=fixture();f.currentOwner='other';assert.ok(check(f).steps.cloudReviewBuildTest.reasons.includes('OWNER_CHANGE_NOT_ALLOWED'));
 for(const override of [{branch:'main'},{commit:'b'.repeat(40)},{clean:false},{repository:'https://example.invalid/other'}])assert.equal(check(fixture(),{...source,...override}).steps.cloudReviewBuildTest.status,'BLOCKED');
});
test('Mac synchronization and exact-commit local verification have separate requirements',()=>{
 const f=fixture();f.mac.online=true;f.mac.commit='b'.repeat(40);
 assert.equal(check(f).steps.macManualSync.status,'CHECKABLE');assert.ok(check(f).steps.macLocalVerification.reasons.includes('MAC_EXACT_COMMIT_REQUIRED'));
 f.mac.commit=commit;assert.equal(check(f).steps.macLocalVerification.status,'CHECKABLE');
 for(const key of ['worktreeClean','preserveDataAndConfig','localDependenciesVerified']){const x=structuredClone(f);x.mac[key]=false;assert.equal(check(x).steps.macLocalVerification.status,'BLOCKED');}
});
test('expired or absent Mac evidence does not block cloud checks',()=>{
 for(const mac of [undefined,{...fixture().mac,online:true,validUntil:'2026-10-20T09:00:00Z'}]){const f=fixture();f.mac=mac;assert.equal(check(f).steps.cloudReviewBuildTest.status,'CHECKABLE');assert.equal(check(f).steps.macManualSync.status,'BLOCKED');}
});
test('uncertain, submitted and completed history never implies retry, including old safety-domain evidence',()=>{
 for(const state of ['UNKNOWN','RECONCILE_PENDING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','PREPARING','PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_WRITTEN','DRAFT_API_WRITTEN_NOT_PUBLISHED']){
  const f=fixture();f.history.jobs=[{workspace:f.workspace,accountId:f.accountId,state}];const r=check(f);assert.ok(r.steps.publication.reasons.includes('EXISTING_OR_UNCERTAIN_RESULT_NO_REPLAY'),state);assert.equal(r.steps.cloudReviewBuildTest.status,'CHECKABLE');
 }
 for(const extra of [{submitSafetyDomain:'MAY_HAVE_SUBMITTED'},{preparationEffectsMayRemain:true}]){const f=fixture();f.history.jobs=[{workspace:f.workspace,accountId:f.accountId,state:'BLOCKED',...extra}];assert.ok(check(f).steps.publication.reasons.includes('EXISTING_OR_UNCERTAIN_RESULT_NO_REPLAY'));}
});
test('wrong account, incomplete history and unknown states fail closed',()=>{
 const f=fixture();f.history.jobs=[{workspace:f.workspace,accountId:'other',state:'UNKNOWN'}];assert.ok(check(f).steps.publication.reasons.includes('HISTORY_SCOPE_MISMATCH'));
 f.history.complete=false;assert.ok(check(f).steps.publication.reasons.includes('HISTORY_INCOMPLETE_OR_EXPIRED'));
 f.history.jobs=[{workspace:f.workspace,accountId:f.accountId,state:'NEW_STATE'}];assert.ok(check(f).steps.publication.reasons.includes('UNRECOGNIZED_HISTORY_STATE'));
});

import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
test('CLI observes real checkout without mutation and never echoes input secrets',()=>{
 const root=mkdtempSync(join(tmpdir(),'continuation-cli-')),path=join(root,'input.json');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
 const before=git('status','--porcelain');
 try{
  const f=fixture();f.targetCommit=git('rev-parse','HEAD');f.unusedSecret='synthetic-do-not-echo';writeFileSync(path,JSON.stringify(f));
  const output=execFileSync(process.execPath,['scripts/check-continuation.mjs',path],{encoding:'utf8'});
  assert.ok(!output.includes(f.unusedSecret));const r=JSON.parse(output);assert.equal(r.advisoryOnly,true);assert.equal(r.steps.publication.status,'BLOCKED');
  assert.equal(git('status','--porcelain'),before);
  writeFileSync(path,'invalid synthetic-do-not-echo');const failed=spawnSync(process.execPath,['scripts/check-continuation.mjs',path],{encoding:'utf8'});assert.equal(failed.status,1);assert.ok(!failed.stderr.includes('synthetic-do-not-echo'));
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('repository identity accepts exact HTTPS and SSH transports, not lookalikes',()=>{
 for(const repository of [
  'https://github.com/ian453-ui/vietbridge-publisher-p0',
  'https://github.com/ian453-ui/vietbridge-publisher-p0.git',
  'git@github.com:ian453-ui/vietbridge-publisher-p0.git',
  'git@github.com:ian453-ui/vietbridge-publisher-p0',
  'ssh://git@github.com/ian453-ui/vietbridge-publisher-p0.git',
  'ssh://git@github.com/ian453-ui/vietbridge-publisher-p0',
 ])assert.equal(check(fixture(),{...source,repository}).steps.cloudReviewBuildTest.status,'CHECKABLE',repository);
 for(const repository of [
  'https://github.com/other/vietbridge-publisher-p0.git',
  'git@github.com:other/vietbridge-publisher-p0.git',
  'ssh://git@github.com/other/vietbridge-publisher-p0.git',
  'https://github.com/ian453-ui/other.git',
  'git@github.com:ian453-ui/other.git',
  'ssh://git@github.com/ian453-ui/other.git',
  'https://github.com.evil.invalid/ian453-ui/vietbridge-publisher-p0.git',
  'git@evil.invalid:ian453-ui/vietbridge-publisher-p0.git',
  'ssh://git@evil.invalid/ian453-ui/vietbridge-publisher-p0.git',
  'https://github.com@evil.invalid/ian453-ui/vietbridge-publisher-p0.git',
  'https://user@github.com/ian453-ui/vietbridge-publisher-p0.git',
  'ssh://root@github.com/ian453-ui/vietbridge-publisher-p0.git',
  'ssh://git@github.com:2222/ian453-ui/vietbridge-publisher-p0.git',
  'http://github.com/ian453-ui/vietbridge-publisher-p0.git',
  'https://github.com/ian453-ui/vietbridge-publisher-p0.git?x=1',
  'git@github.com:ian453-ui/vietbridge-publisher-p0.git/extra',
  null, {},
 ])assert.ok(check(fixture(),{...source,repository}).steps.cloudReviewBuildTest.reasons.includes('SOURCE_IDENTITY_MISMATCH'),String(repository));
});
