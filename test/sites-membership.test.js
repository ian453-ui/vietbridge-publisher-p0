import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSitesScopeResolver} from '../src/sites/membership.js';
import {createSitesReadonlyApi} from '../src/sites/readonly-api.js';
const migration=readFileSync(new URL('../src/sites/migrations/0001_readonly_projection.sql',import.meta.url),'utf8');
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'sites-members-')),path=join(root,'synthetic.sqlite');let sql=new DatabaseSync(path);
 sql.exec('PRAGMA foreign_keys=ON');sql.exec(migration);
 t.after(()=>{sql.close();rmSync(root,{recursive:true,force:true});});
 for(const [ws,account] of [['w1','a1'],['w1','a2'],['w2','a3']]){
 sql.prepare('INSERT INTO facebook_accounts VALUES(?,?)').run(account,ws);
 sql.prepare('INSERT INTO publisher_content_sources VALUES(?,?,?,?,?)').run(ws,account,'1',account,'synthetic-payload');
 sql.prepare('INSERT INTO publisher_jobs VALUES(?,?,?,?,?,?,?,?,?)').run(account,ws,account,account,'synthetic-snapshot','UNKNOWN','original-attempt','2026-01-01','2026-01-01');
 }
 sql.exec("INSERT INTO sites_project_memberships VALUES('trusted-user','w1','a1','READER',NULL)");
 let identity={userId:'trusted-user'},reads=0;
 const db={prepare(query){assert.match(query,/^SELECT /);return {bind(...args){return {async all(){reads++;return {success:true,results:sql.prepare(query).all(...args)};}};}};}};
 const resolveScope=createSitesScopeResolver({db,getTrustedIdentity:async()=>identity});
 const api=createSitesReadonlyApi({db,origin:'https://fixture.invalid',resolveScope});
 const url='https://fixture.invalid/api/unified/workspaces/w1/jobs?accountId=a1';
 return {get sql(){return sql;},api,url,get reads(){return reads;},set identity(x){identity=x;},reopen(){sql.close();sql=new DatabaseSync(path);sql.exec('PRAGMA foreign_keys=ON');}};
}
test('trusted identity requires persisted membership; client identity/member claims cannot grant access',async t=>{
 const f=setup(t);f.identity=null;
 assert.equal((await f.api(new Request(f.url,{headers:{'oai-authenticated-user-id':'trusted-user','x-role':'READER','x-account-id':'a1'}}))).status,401);assert.equal(f.reads,0);
 f.identity={userId:'unlisted'};assert.equal((await f.api(new Request(f.url+'&userId=trusted-user&role=READER'))).status,403);
 f.identity={userId:'trusted-user'};assert.equal((await f.api(new Request(f.url))).status,200);
 f.sql.exec("UPDATE sites_project_memberships SET revoked_at='2026-01-02'");assert.equal((await f.api(new Request(f.url))).status,403);
});
test('membership is account and workspace scoped, including injection-shaped selectors',async t=>{
 const f=setup(t);
 for(const url of [f.url.replace('a1','a2'),f.url.replace('w1','w2').replace('a1','a3'),f.url.replace('a1',encodeURIComponent("a1' OR 1=1 --"))])assert.equal((await f.api(new Request(url))).status,403);
 assert.throws(()=>f.sql.prepare('INSERT INTO sites_project_memberships VALUES(?,?,?,?,NULL)').run('trusted-user','w2','a1','READER'),/FOREIGN KEY/);
 assert.throws(()=>f.sql.prepare('INSERT INTO sites_project_memberships VALUES(?,?,?,?,NULL)').run('trusted-user','w1','a2','ADMIN'),/CHECK/);
});
test('pagination bounds and all writes remain denied after valid membership',async t=>{
 const f=setup(t);
 for(const q of ['limit=0','limit=201','limit=1.5','offset=-1','offset=9007199254740992','limit=NaN'])assert.equal((await f.api(new Request(f.url+'&'+q))).status,400);
 assert.equal((await f.api(new Request(f.url+'&limit=200&offset=0'))).status,200);
 const empty=await (await f.api(new Request(f.url+'&offset=1'))).json();assert.deepEqual(empty.jobs,[]);
 const before=f.sql.prepare('SELECT total_changes() n').get().n;
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await f.api(new Request(f.url,{method}))).status,405);
 assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,before);
});
test('schema uniqueness rejects duplicate/conflicting source revisions and jobs; reopen preserves UNKNOWN',async t=>{
 const f=setup(t);
 for(const hash of ['synthetic-payload','conflicting'])assert.throws(()=>f.sql.prepare('INSERT INTO publisher_content_sources VALUES(?,?,?,?,?)').run('w1','a1','1','a1',hash),/UNIQUE/);
 assert.throws(()=>f.sql.exec("INSERT INTO publisher_jobs SELECT 'another-id',workspace,account_id,content_id,snapshot_hash,state,attempt_id,created_at,updated_at FROM publisher_jobs WHERE id='a1'"),/UNIQUE/);
 assert.throws(()=>f.sql.exec(migration),/already exists/);
 f.reopen();const b=await (await f.api(new Request(f.url))).json();assert.equal(b.jobs.length,1);assert.equal(b.jobs[0].state,'UNKNOWN');assert.equal(b.jobs[0].attempt_id,'original-attempt');assert.equal(b.jobs[0].canExecute,false);
 const ledger=await (await f.api(new Request(f.url.replace('/jobs?','/source-ledger?')))).json();assert.equal(ledger.sources.length,1);assert.equal(ledger.sources[0].payload_hash,'synthetic-payload');
});
test('missing trusted integration refuses construction; membership storage failure denies access',async t=>{
 assert.throws(()=>createSitesScopeResolver(),/IDENTITY_BINDING_REQUIRED/);
 const resolveScope=createSitesScopeResolver({db:{prepare(){throw Error('internal secret');}},getTrustedIdentity:async()=>({userId:'trusted-user'})});
 const f=setup(t),api=createSitesReadonlyApi({db:{prepare(){}},origin:'https://fixture.invalid',resolveScope});const r=await api(new Request(f.url));assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/secret/);
});
