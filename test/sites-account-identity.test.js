import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';

function setup(t){const root=mkdtempSync(join(tmpdir(),'sites-identity-')),f=cloudD1Fixture(join(root,'db.sqlite'));t.after(()=>{f.close();rmSync(root,{recursive:true,force:true});});return f;}
async function seed(f){const w=(await f.call('/api/sites/workspaces',{command_id:crypto.randomUUID(),name:'Enterprise'})).body.id,a=(await f.call('/api/sites/workspaces/'+w+'/accounts',{command_id:crypto.randomUUID(),display_name:'XHS',platform:'xiaohongshu',external_identity:null})).body.id;return {w,a,path:'/api/sites/workspaces/'+w+'/accounts/'+a+'/identity'};}
const input=()=>({command_id:crypto.randomUUID(),external_identity:'redid:1234567890',evidence_note:'Synthetic read-only profile identity check'});

test('fills existing XHS identity once with scoped audit but no authorization grant',async t=>{
 const f=setup(t),{w,a,path}=await seed(f),body=input();
 const first=await f.call(path,body);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.account_id,a);
 const again=await f.call(path,body);assert.equal(again.status,200);assert.equal(again.body.duplicate,true);
 const account=f.sql.prepare('SELECT external_identity,authorization_state FROM sites_account_details WHERE workspace=? AND account_id=?').get(w,a);
 assert.deepEqual({...account},{external_identity:body.external_identity,authorization_state:'UNCONFIGURED'});
 const audit=f.sql.prepare('SELECT actor_user_id,old_identity,new_identity,evidence_note FROM sites_account_identity_events WHERE workspace=? AND account_id=?').all(w,a);
 assert.equal(audit.length,1);assert.deepEqual({...audit[0]},{actor_user_id:'synthetic-owner',old_identity:null,new_identity:body.external_identity,evidence_note:body.evidence_note});
 assert.equal((await f.call(path,input())).body.error,'ACCOUNT_IDENTITY_LOCKED');
});

test('denies cross workspace, revoked membership, changed origin and wrong method',async t=>{
 const f=setup(t),{w,a,path}=await seed(f),body=input();
 f.user='other';assert.equal((await f.call(path,body)).status,403);
 f.user='synthetic-owner';assert.equal((await f.call(path,body,{headers:{origin:'https://foreign.invalid'}})).status,403);
 assert.equal((await f.call(path,undefined,{method:'GET'})).status,405);
 f.sql.prepare('UPDATE sites_project_memberships SET revoked_at=? WHERE workspace=? AND account_id=?').run('2026-10-24T00:00:00.000Z',w,a);
 assert.equal((await f.call(path,body)).status,403);
 assert.equal(f.sql.prepare('SELECT external_identity FROM sites_account_details WHERE workspace=? AND account_id=?').get(w,a).external_identity,null);
});

test('existing frozen or unresolved job blocks identity change and preserves account',async t=>{
 const f=setup(t),{w,a,path}=await seed(f);
 f.sql.prepare("INSERT INTO publisher_jobs(id,workspace,account_id,content_id,snapshot_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,'UNKNOWN',?,?)").run(crypto.randomUUID(),w,a,'synthetic-content','a'.repeat(64),'2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
 assert.equal((await f.call(path,input())).body.error,'ACCOUNT_IDENTITY_LOCKED');
 assert.equal(f.sql.prepare('SELECT external_identity FROM sites_account_details WHERE workspace=? AND account_id=?').get(w,a).external_identity,null);
});

test('existing legacy review also blocks identity change',async t=>{
 const f=setup(t),{w,a,path}=await seed(f),task=crypto.randomUUID();
 f.sql.prepare('INSERT INTO sites_task_bindings(task_id,workspace,account_id,identity_hash) VALUES(?,?,?,?)').run(task,w,a,null);
 f.sql.prepare("INSERT INTO sites_reviews(id,task_id,request_revision,workspace,account_id,request_json,result_json,report_json,envelope_hash,result_fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'REVIEW_REQUIRED',?)").run(crypto.randomUUID(),task,1,w,a,'{}','{}','{}','a'.repeat(64),'b'.repeat(64),'2026-10-24T00:00:00.000Z');
 const result=await f.call(path,input());assert.equal(result.body.error,'ACCOUNT_IDENTITY_LOCKED');
 assert.equal(f.sql.prepare('SELECT external_identity FROM sites_account_details WHERE workspace=? AND account_id=?').get(w,a).external_identity,null);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_account_identity_events').get().n,0);
});

test('legacy review arriving after preflight is rejected by the transaction guard',async t=>{
 const f=setup(t),{w,a,path}=await seed(f),task=crypto.randomUUID(),original=f.db.batch.bind(f.db);let inserted=false;
 f.db.batch=async statements=>{
  if(!inserted&&statements.some(s=>s.query.includes('UPDATE sites_account_details SET external_identity'))){
   inserted=true;f.sql.prepare('INSERT INTO sites_task_bindings(task_id,workspace,account_id,identity_hash) VALUES(?,?,?,?)').run(task,w,a,null);
   f.sql.prepare("INSERT INTO sites_reviews(id,task_id,request_revision,workspace,account_id,request_json,result_json,report_json,envelope_hash,result_fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'REVIEW_REQUIRED',?)").run(crypto.randomUUID(),task,1,w,a,'{}','{}','{}','a'.repeat(64),'b'.repeat(64),'2026-10-24T00:00:00.000Z');
  }
  return original(statements);
 };
 const result=await f.call(path,input());assert.equal(inserted,true);assert.notEqual(result.status,200);
 assert.equal(f.sql.prepare('SELECT external_identity FROM sites_account_details WHERE workspace=? AND account_id=?').get(w,a).external_identity,null);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_account_identity_events').get().n,0);
});
