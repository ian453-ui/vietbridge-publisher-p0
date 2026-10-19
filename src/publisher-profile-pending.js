// Only an explicitly finished preparation-only UNKNOWN releases the browser.
// An uncertain final submission keeps the global hold even if an operator
// later closes the UI task. Exact-content duplicate guards remain separate.
export function archivedPreparationOnlyUnknown(db,row) {
  if(row.state!=='UNKNOWN')return false;
  let evidence;
  try {evidence=JSON.parse(row.evidence_json||'{}');}catch{return false;}
  if(evidence.operatorFinished!==true||evidence.stage!=='PREPARING'||
    ![0,false].includes(evidence.submissionIntent)||
    !(evidence.preSubmissionVerified===true||[0,false].includes(evidence.browserDiagnostics?.finalClickAttempted))||
    evidence.browserDiagnostics?.finalClickAttempted===true)return false;
  const table=name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!table('publisher_submit_intents')||!table('publisher_submit_receipts'))return false;
  return !db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=? LIMIT 1').get(row.id)&&
    !db.prepare('SELECT 1 FROM publisher_submit_receipts WHERE job_id=? LIMIT 1').get(row.id);
}

// A failed launch or other pre-form failure is not a platform publication.
// Keep the attempt in evidence/events, but do not spend the Page publication
// budget when the exact attempt is proven to have made no external writes.
export function provenPristinePreSubmit(db,row) {
  if(!['BLOCKED','DRAFT','READY'].includes(row.state))return false;
  let evidence;
  try {evidence=JSON.parse(row.evidence_json||'{}');}catch{return false;}
  const failure=evidence.preparationFailure;
  if(!failure||failure.finalSubmitNotCalled!==true||failure.preparationEffectsMayRemain!==false||
    evidence.preparationEffectsMayRemain!==false||evidence.stage!=='PREPARING'||
    evidence.submissionIntent!==false||evidence.submitCallMayHaveStarted!==false||
    !failure.attemptId||!failure.snapshotHash||failure.snapshotHash!==row.snapshot_hash)return false;
  if(row.state==='BLOCKED'&&row.attempt_id!==failure.attemptId)return false;
  if(row.state!=='BLOCKED'&&(row.attempt_id!==null||evidence.preSubmissionRecovery?.attemptId!==failure.attemptId))return false;
  for(const table of ['publisher_prepare_intents','publisher_submit_intents','publisher_submit_receipts']){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)||
      db.prepare(`SELECT 1 FROM ${table} WHERE job_id=?`).get(row.id))return false;
  }
  return true;
}

// An operator may recover an exact pre-form failure without deleting its
// prepare-intent history. It counts again as soon as another attempt is claimed.
export function recoveredPristinePreparation(db,row) {
  if(row.state!=='READY'||row.attempt_id!==null)return false;
  let evidence,snapshot;
  try {evidence=JSON.parse(row.evidence_json||'{}');snapshot=JSON.parse(row.snapshot_json||'{}');}catch{return false;}
  const r=evidence.pristinePreparationRecovery;
  if(r?.version!==1||r.errorCode!=='BODY_SELECTOR_OVERLAY_STRICT'||
    r.sourceBuild!=='7686640800ed9cc99ee33f22681ea2dc738353ba'||
    r.originalState!=='UNKNOWN'||r.originalStage!=='PREPARING'||
    !/^[0-9a-f-]{36}$/.test(r.originalAttemptId||'')||r.snapshotHash!==row.snapshot_hash||
    r.finalClickAttempted!==false||r.formWriteReached!==false||r.submissionIntent!==false||
    !Number.isFinite(Date.parse(r.at))||
    snapshot.platform!=='facebook'||snapshot.transport!=='BROWSER'||
    !String(evidence.error||'').includes("locator('body') resolved to 2 elements")||
    !String(evidence.error||'').includes('browser-skill-overlay body'))return false;
  const has=t=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if(!has('publisher_prepare_intents')||!has('publisher_submit_intents')||!has('publisher_submit_receipts')||!has('events'))return false;
  if(!db.prepare('SELECT 1 FROM publisher_prepare_intents WHERE job_id=?').get(row.id)||
    db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(row.id)||
    db.prepare('SELECT 1 FROM publisher_submit_receipts WHERE job_id=?').get(row.id))return false;
  return Boolean(db.prepare("SELECT 1 FROM events WHERE workspace=? AND event='publisher_pristine_preparation_recovered' AND json_extract(value,'$.job_id')=? AND json_extract(value,'$.original_attempt_id')=? LIMIT 1").get(row.workspace,row.id,r.originalAttemptId));
}
export function pendingPublisherProfileRows(db, profileId) {
  if (!profileId) return [];
  return db.prepare(`SELECT id,state,evidence_json FROM publisher_jobs
    WHERE json_extract(snapshot_json,'$.profileId')=?
      AND state IN ('PREPARING','SUBMITTING','UNKNOWN')`).all(profileId)
      .filter(row=>!archivedPreparationOnlyUnknown(db,row));
}
