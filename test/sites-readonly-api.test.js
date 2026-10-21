import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {createSitesReadonlyApi} from '../src/sites/readonly-api.js';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'sites-readonly-'));const store=new Store(join(root,'fixture.sqlite'),{seedDemo:false});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const publisher=new UnifiedPublisher(store),ws=store.saveWorkspace({name:'Synthetic',content_root:root});
 const profile=store.saveProfile(ws.id,{name:'Synthetic',cdp_port:19853,user_data_dir:join(root,'profile')});
 const account=publisher.saveAccount(ws.id,{display_name:'Synthetic',expected_identity:'Synthetic',identity_type:'PAGE',external_id:'123',operator_actor_id:'123',target_page_id:'456',profile_id:profile.id});
 const input={source_id:'SYNTHETIC',revision:'1',body:'Synthetic only',media:[]};
 const content=publisher.importContent(ws.id,input);assert.equal(publisher.importContent(ws.id,input).id,content.id);
 const job=publisher.createPageJob(ws.id,{account_id:account.id,content_id:content.id});
 store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='synthetic-attempt' WHERE id=?").run(job.id);
 let reads=0;
 // D1-shaped async facade over actual project SQLite schema. Not a D1 emulator.
 const db={prepare(sql){assert.match(sql,/^SELECT /);return {bind(...args){return {async all(){reads++;return {success:true,results:store.db.prepare(sql).all(...args)};}};}};}};
 const scope={userId:'synthetic-user',workspace:ws.id,accountIds:[account.id]};
 const api=createSitesReadonlyApi({db,origin:'https://fixture.invalid',resolveScope:async()=>scope});
 const url=`https://fixture.invalid/api/unified/workspaces/${ws.id}/jobs?accountId=${account.id}`;
 return {store,publisher,ws,account,job,db,scope,api,url,get reads(){return reads;}};
}
test('original ledger idempotence and UNKNOWN survive repeated async scoped readback',async t=>{
 const f=setup(t);
 for(let i=0;i<2;i++){
 const r=await f.api(new Request(f.url));assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const b=await r.json();assert.equal(b.jobs.length,1);assert.equal(b.jobs[0].state,'UNKNOWN');assert.equal(b.jobs[0].attempt_id,'synthetic-attempt');assert.equal(b.jobs[0].canExecute,false);assert.equal(b.transactionWritesSupported,false);assert.equal(b.jobs[0].snapshot_json,undefined);
 const ledger=await (await f.api(new Request(f.url.replace('/jobs?','/source-ledger?')))).json();assert.equal(ledger.sources.length,1);
 }
 assert.equal(f.publisher.job(f.ws.id,f.job.id).state,'UNKNOWN');
});
test('identity, workspace, account, host and pagination fail before storage',async t=>{
 const f=setup(t);
 for(const [url,status] of [[f.url.replace(f.ws.id,'other'),403],[f.url.replace(f.account.id,'other'),403],[f.url.replace('fixture.invalid','wrong.invalid'),409],[f.url+'&limit=201',400],[f.url.split('?')[0],403]])assert.equal((await f.api(new Request(url))).status,status);
 f.scope.userId=null;assert.equal((await f.api(new Request(f.url))).status,401);assert.equal(f.reads,0);
});
test('all write methods deny without consuming budget, permit or recovering UNKNOWN',async t=>{
 const f=setup(t),before=f.store.db.prepare('SELECT total_changes() n').get().n;
 for(const method of ['POST','PUT','PATCH','DELETE'])for(const suffix of ['','/approve','/execute','/reconcile','/reopen'])assert.equal((await f.api(new Request(f.url.split('?')[0]+suffix,{method}))).status,405);
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.reads,0);
});
test('missing bindings and storage errors fail closed without exposing details',async t=>{
 const f=setup(t);assert.equal((await createSitesReadonlyApi()(new Request(f.url))).status,503);
 const api=createSitesReadonlyApi({db:{prepare(){throw Error('secret database path');}},origin:'https://fixture.invalid',resolveScope:async()=>f.scope});
 const r=await api(new Request(f.url));assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret/);
});
test('scoped SQL excludes other account jobs and inconsistent account ownership',async t=>{
 const f=setup(t);
 const profile=f.store.saveProfile(f.ws.id,{name:'Other',cdp_port:19854,user_data_dir:join(tmpdir(),'synthetic-other-profile')});
 const other=f.publisher.saveAccount(f.ws.id,{display_name:'Other',expected_identity:'Other',identity_type:'PAGE',external_id:'789',operator_actor_id:'789',target_page_id:'987',profile_id:profile.id});
 const c=f.publisher.importContent(f.ws.id,{source_id:'OTHER',revision:'1',body:'Other scope',media:[]});
 f.publisher.createPageJob(f.ws.id,{account_id:other.id,content_id:c.id});
 let b=await (await f.api(new Request(f.url))).json();assert.deepEqual(b.jobs.map(x=>x.id),[f.job.id]);
 b=await (await f.api(new Request(f.url.replace('/jobs?','/source-ledger?')))).json();assert.deepEqual(b.sources.map(x=>x.source_id),['SYNTHETIC']);
 f.store.db.prepare('UPDATE facebook_accounts SET workspace=? WHERE id=?').run('inconsistent-workspace',f.account.id);
 b=await (await f.api(new Request(f.url))).json();assert.deepEqual(b.jobs,[]);
});
