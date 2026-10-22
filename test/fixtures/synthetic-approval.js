import {randomUUID,createHash} from 'node:crypto';
import {productionReviewChecks} from '../../src/production-approval-store.js';

// Test-only provenance, never an authenticated producer or a production registration endpoint.
export function seedSyntheticApproval(reviewStore,reviewId,scope){
 const row=reviewStore.approvals.row(reviewId,scope),request=JSON.parse(row.request_json);
 if(!request.task_id.startsWith('SYNTHETIC-')||request.items.some(x=>!x.source_id.startsWith('SYNTHETIC-')))throw Error('SYNTHETIC_FIXTURE_REQUIRED');
 reviewStore.db.prepare('INSERT INTO production_review_provenance VALUES(?,?,?,?,?)').run(reviewId,'SYNTHETIC_FIXTURE',reviewId,row.result_fingerprint,reviewStore.approvals.accountHash(row.workspace,row.account_id));
 return reviewStore.approvals.view(reviewId,scope,{admin:true});
}
export const syntheticAdmin={kind:'EXISTING_ADMIN',actor_id:'admin:'+createHash('sha256').update('synthetic-admin').digest('hex')};
export function approvalCommand(view,{decision='APPROVE',reason='Synthetic human-flow acceptance'}={}){
 return {command_id:randomUUID(),decision,expected_subject:view.subject_fingerprint,expected_event_id:view.latest_event_id,reason,checks:Object.fromEntries(productionReviewChecks.map(k=>[k,true])),confirmation:'CONTENT_ONLY'};
}
