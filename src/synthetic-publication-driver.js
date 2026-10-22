import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const factories=new WeakSet(),hash=x=>createHash('sha256').update(x).digest('hex');
export const isSyntheticPublicationFactory=factory=>factories.has(factory);

/** Closed local simulator: no network, injected callbacks, browser or credential access. */
export function syntheticPublicationFactory(db){
 db.exec('CREATE TABLE IF NOT EXISTS synthetic_publication_objects(plan_id TEXT PRIMARY KEY,object_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,media_json TEXT NOT NULL)');
 let fault='NONE',prepares=0,submits=0,reads=0;
 const factory=Object.freeze({
  setFault(value){if(!['NONE','UPLOAD_FAILED','SUBMIT_RESPONSE_LOST','READBACK_UNAVAILABLE'].includes(value))throw Error('SYNTHETIC_FAULT_INVALID');fault=value;},
  stats(){return {prepares,submits,reads};},
  async create(snapshot){
   if(snapshot.productionReview?.synthetic_only!==true)throw Error('SYNTHETIC_REVIEW_TASK_REQUIRED');
   const planId=snapshot.productionReview.plan_id;let media;
   return {
    async prepare(s,paths,onWrite){prepares++;media=paths.map(path=>({sha256:hash(readFileSync(path))}));onWrite();if(fault==='UPLOAD_FAILED')throw Error('SYNTHETIC_UPLOAD_FAILED');return {synthetic_only:true,media};},
    restore(s,paths,prepared){media=prepared?.media||paths.map(path=>({sha256:hash(readFileSync(path))}));},
    async submit(){submits++;const objectId='synthetic-'+planId;db.prepare('INSERT INTO synthetic_publication_objects VALUES(?,?,?,?)').run(planId,objectId,JSON.stringify(snapshot),JSON.stringify(media));if(fault==='SUBMIT_RESPONSE_LOST')throw Error('SYNTHETIC_SUBMIT_RESPONSE_LOST');return {id:objectId,url:'https://synthetic.invalid/'+objectId};},
    async readback(s){
     reads++;if(fault==='READBACK_UNAVAILABLE')throw Error('SYNTHETIC_READBACK_UNAVAILABLE');
     const row=db.prepare('SELECT * FROM synthetic_publication_objects WHERE plan_id=?').get(planId);if(!row||row.snapshot_json!==JSON.stringify(s)||row.media_json!==JSON.stringify(media))throw Error('SYNTHETIC_READBACK_MISMATCH');
     const outcome=s.platform==='wechat_official_account'?'DRAFT_WRITTEN':s.platform==='wechat_channels'?'PUBLISHED_ID_PENDING':'PUBLISHED';
     return {verified:true,syntheticOnly:true,method:'LOCAL_SYNTHETIC_READBACK',id:row.object_id,url:'https://synthetic.invalid/'+row.object_id,platform:s.platform,accountId:s.externalId,targetPageId:s.targetPageId,operatorActorId:s.operatorActorId,contentHash:s.contentHash,payloadHash:s.payloadHash,outcome,...(s.platform==='wechat_official_account'?{formalPublication:false}:{}),...(s.platform==='wechat_channels'?{publicLinkUnavailable:true}:{}),media};
    },
    async close(){}
   };
  }
 });factories.add(factory);return factory;
}
