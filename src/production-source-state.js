import {createHash} from 'node:crypto';

const active=new WeakMap();
export function resetSourceProviders(db){active.delete(db);}
export const sourceDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function initializeSourceEvidence(db){
 db.exec(`
 CREATE TABLE IF NOT EXISTS production_source_requirements(review_id TEXT PRIMARY KEY,config_json TEXT NOT NULL,config_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS production_source_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,review_id TEXT NOT NULL,subject_fingerprint TEXT NOT NULL,started_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS production_source_attempt_order ON production_source_attempts(review_id,id);
 CREATE TABLE IF NOT EXISTS production_source_receipts(attempt_id INTEGER PRIMARY KEY,finished_at INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT,raw BLOB,raw_sha256 TEXT,binding_hash TEXT,decision_json TEXT,observed_at INTEGER);
 CREATE TABLE IF NOT EXISTS production_source_decisions(review_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,record_json TEXT NOT NULL,record_hash TEXT NOT NULL,PRIMARY KEY(review_id,sequence),UNIQUE(review_id,event_id));
 CREATE TABLE IF NOT EXISTS production_approval_source_bindings(event_id TEXT PRIMARY KEY,attempt_id INTEGER NOT NULL,decision_hash TEXT NOT NULL,binding_hash TEXT NOT NULL);
 `);
 for(const table of ['production_source_requirements','production_source_attempts','production_source_receipts','production_source_decisions','production_approval_source_bindings'])for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'SOURCE_AUDIT_IMMUTABLE'); END;`);
}
// A process-local adapter must be attached again after restart. Persisted evidence is never a provider.
export function activateSourceProvider(db,id,configHash){let entries=active.get(db);if(!entries){entries=new Map();active.set(db,entries);}entries.set(id,configHash);}
export function sourceEvidenceState(db,id,subjectFingerprint,now=Date.now()){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_source_requirements'").get())return {required:false,status:'UNCONFIGURED',blocked:null};
 const requirement=db.prepare('SELECT * FROM production_source_requirements WHERE review_id=?').get(id);
 if(!requirement)return {required:false,status:'UNCONFIGURED',blocked:null};
 const config=JSON.parse(requirement.config_json),attempt=db.prepare('SELECT * FROM production_source_attempts WHERE review_id=? ORDER BY id DESC LIMIT 1').get(id),receipt=attempt&&db.prepare('SELECT * FROM production_source_receipts WHERE attempt_id=?').get(attempt.id);
 let blocked=null;
 if(sourceDigest(config)!==requirement.config_hash)blocked='SOURCE_REQUIREMENT_CORRUPT';
 else if(active.get(db)?.get(id)!==requirement.config_hash)blocked='SOURCE_PROVIDER_UNAVAILABLE';
 else if(!attempt||!receipt)blocked='SOURCE_VERIFICATION_PENDING';
 else if(attempt.subject_fingerprint!==subjectFingerprint)blocked='SOURCE_SUBJECT_CHANGED';
 else if(receipt.status!=='VERIFIED')blocked=receipt.reason||'SOURCE_VERIFICATION_FAILED';
 else if(!receipt.raw||createHash('sha256').update(receipt.raw).digest('hex')!==receipt.raw_sha256)blocked='SOURCE_RECEIPT_CORRUPT';
 else if(now<attempt.started_at||now-attempt.started_at>config.max_age_ms||!Number.isSafeInteger(receipt.observed_at)||now-receipt.observed_at>config.max_age_ms)blocked='SOURCE_EVIDENCE_EXPIRED';
 const decision=receipt?.decision_json?JSON.parse(receipt.decision_json):null;
 // Attempt order cannot erase a newer authoritative revocation discovered by an older read.
 if(!blocked){const latest=db.prepare('SELECT record_hash,record_json FROM production_source_decisions WHERE review_id=? ORDER BY sequence DESC LIMIT 1').get(id);if(!latest||latest.record_hash!==sourceDigest(decision))blocked=latest&&JSON.parse(latest.record_json).kind==='REVOKED'?'SOURCE_APPROVAL_REVOKED':'SOURCE_APPROVAL_CHANGED';}
 return {required:true,status:blocked?'BLOCKED':'VERIFIED',blocked,provider_id:config.provider_id,attempt_id:attempt?.id??null,checked_at:attempt?new Date(attempt.started_at).toISOString():null,binding_hash:receipt?.binding_hash??null,decision_hash:decision?sourceDigest(decision):null,decision:decision?{id:decision.id,sequence:decision.sequence,kind:decision.kind}:null};
}
export function approvalSourceChanged(db,eventId,state){
 if(!state.required)return false;
 const row=db.prepare('SELECT * FROM production_approval_source_bindings WHERE event_id=?').get(eventId);
 return !row||row.decision_hash!==state.decision_hash||row.binding_hash!==state.binding_hash;
}
export function bindApprovalSource(db,eventId,state){
 if(!state.required)return;
 if(state.blocked||!state.attempt_id||!state.decision_hash||!state.binding_hash)throw Error('SOURCE_APPROVAL_BINDING_UNAVAILABLE');
 db.prepare('INSERT INTO production_approval_source_bindings VALUES(?,?,?,?)').run(eventId,state.attempt_id,state.decision_hash,state.binding_hash);
}
