import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createCloudAuthoringApi} from '../../src/sites/cloud-authoring-api.js';

// Actual SQLite behind the asynchronous D1 shape, NOT hosted D1 acceptance.
export function cloudD1Fixture(path,{initialize=true}={}){
 const sql=new DatabaseSync(path);sql.exec('PRAGMA foreign_keys=ON');sql.exec('PRAGMA busy_timeout=5000');
 if(initialize)for(const file of ['0001_readonly_projection.sql','0002_cloud_authoring_candidate.sql','0003_evidence_storage_candidate.sql','0004_authorization_guard_candidate.sql','0005_review_handoff_candidate.sql','0006_source_import_candidate.sql','0007_execution_permits_candidate.sql','0008_target_review_candidate.sql'])sql.exec(readFileSync(new URL('../../src/sites/migrations/'+file,import.meta.url),'utf8'));
 let fault=-1,user='synthetic-owner',reads=0,writes=0;
 const db={prepare(query){if(/;\s*\S/.test(query))throw Error('ONE_STATEMENT_REQUIRED');return {bind(...args){args=args.map(x=>x instanceof ArrayBuffer?new Uint8Array(x):x);return {query,args,async all(){reads++;return {success:true,results:sql.prepare(query).all(...args)};}};}};},async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const results=statements.map((s,i)=>{if(i===fault)throw Error('SYNTHETIC_TRANSACTION_FAILURE');writes++;sql.prepare(s.query).run(...s.args);return {success:true,results:[]};});sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 const origin='https://synthetic-sites.invalid',api=createCloudAuthoringApi({db,origin,getTrustedIdentity:async()=>user?{userId:user}:null});
 async function call(path,body,{headers={},method=body?'POST':'GET'}={}){const res=await api(new Request(origin+path,{method,headers:{...(body?{'content-type':'application/json',origin}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}));return {status:res.status,body:await res.json()};}
 return {sql,db,origin,api,call,set user(v){user=v;},set fault(v){fault=v;},get reads(){return reads;},get writes(){return writes;},close:()=>sql.close()};
}
