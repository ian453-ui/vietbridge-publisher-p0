import {createHash} from 'node:crypto';
import {createProductionRequest,inspectProductionResult,readProductionArtifact} from './production-artifact-contract.js';

const fail=code=>{throw Error(code);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const mime=ext=>({'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[ext]||'text/plain; charset=utf-8');

/** Pending inspection ledger. No approval/import/publish transitions exist here. */
export class ProductionReviewStore {
 constructor(db){
  this.db=db;
  db.exec(`CREATE TABLE IF NOT EXISTS production_reviews(
   id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, request_revision INTEGER NOT NULL,
   workspace TEXT NOT NULL, account_id TEXT NOT NULL, request_json TEXT NOT NULL,
   result_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, created_at TEXT NOT NULL,
   UNIQUE(task_id,request_revision));
   CREATE INDEX IF NOT EXISTS production_review_scope ON production_reviews(workspace,account_id,created_at);
   CREATE TABLE IF NOT EXISTS production_review_assets(
    review_id TEXT NOT NULL, source_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
    mime TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY(review_id,source_id,artifact_id));`);
 }
 scope(workspace,account){
  if(typeof workspace!=='string'||!workspace||typeof account!=='string'||!account||!this.db.prepare('SELECT 1 FROM facebook_accounts WHERE workspace=? AND id=?').get(workspace,account))fail('REVIEW_SCOPE_DENIED');
 }
 ingest(request,result,{root,now=Date.now()}={}){
  this.scope(request.workspace,request.account_id);
  const report=inspectProductionResult(request,result,{root,now}),assets=[];let total=0;
  // Re-open and re-hash the exact snapshots to be retained. A changed file fails.
  for(const item of report.items)for(const artifact of item.artifacts){
   const path=result.items.find(x=>x.source_id===item.source_id).artifacts.find(x=>x.artifact_id===artifact.artifact_id).path;
   const actual=readProductionArtifact(root,path,artifact.kind,{includeBytes:true});
   if(actual.sha256!==artifact.sha256)fail('REVIEW_ASSET_CHANGED');
   total+=actual.bytes;if(total>128*1024*1024)fail('REVIEW_TOTAL_SIZE_LIMIT');
   assets.push({source:item.source_id,id:artifact.artifact_id,mime:mime(actual.extension),sha256:actual.sha256,data:actual.data});
  }
  const id=report.receipt.request_fingerprint;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.scope(request.workspace,request.account_id);
   const prior=this.db.prepare('SELECT * FROM production_reviews WHERE task_id=? ORDER BY request_revision DESC LIMIT 1').get(request.task_id);
   if(prior){
    const {request_fingerprint,assignment_mode,handoff_policy,...input}=request;
    createProductionRequest(input,{priorRequest:JSON.parse(prior.request_json)});
    if(prior.request_revision===request.request_revision){
     if(prior.result_fingerprint!==report.receipt.result_fingerprint)fail('CONFLICTING_RESULT');
     this.db.exec('COMMIT');return {status:'DUPLICATE',id,publish_allowed:false,import_allowed:false};
    }
   }
   this.db.prepare('INSERT INTO production_reviews VALUES(?,?,?,?,?,?,?,?,?)').run(id,request.task_id,request.request_revision,request.workspace,request.account_id,JSON.stringify(request),report.receipt.result_fingerprint,JSON.stringify(report),new Date(now).toISOString());
   const insert=this.db.prepare('INSERT INTO production_review_assets VALUES(?,?,?,?,?,?)');
   for(const a of assets)insert.run(id,a.source,a.id,a.mime,a.sha256,a.data);
   this.db.exec('COMMIT');return {status:'REVIEW_REQUIRED',id,publish_allowed:false,import_allowed:false};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 list(workspace,account){
  this.scope(workspace,account);
  return this.db.prepare('SELECT id,task_id,request_revision,created_at,report_json FROM production_reviews WHERE workspace=? AND account_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(workspace,account).map(({report_json,...row})=>({...row,status:'REVIEW_REQUIRED',items:JSON.parse(report_json).items.map(x=>({source_id:x.source_id,content_revision:x.content_revision,visual_revision:x.visual_revision}))}));
 }
 detail(workspace,account,id){
  this.scope(workspace,account);const row=this.db.prepare('SELECT report_json FROM production_reviews WHERE workspace=? AND account_id=? AND id=?').get(workspace,account,id);
  if(!row)fail('REVIEW_NOT_FOUND');return JSON.parse(row.report_json);
 }
 asset(workspace,account,id,source,artifact){
  this.detail(workspace,account,id);
  const row=this.db.prepare('SELECT mime,sha256,data FROM production_review_assets WHERE review_id=? AND source_id=? AND artifact_id=?').get(id,source,artifact);
  if(!row)fail('REVIEW_NOT_FOUND');
  if(digest(row.data)!==row.sha256)fail('REVIEW_STORAGE_CORRUPT');return row;
 }
}
