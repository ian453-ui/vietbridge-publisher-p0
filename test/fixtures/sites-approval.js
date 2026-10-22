import {join} from 'node:path';
import {sitesEvidenceFixture,fileBucket,inspectedPacket} from './sites-evidence.js';
import {AsyncReviewStore} from '../../src/sites/async-review-store.js';
import {AsyncApprovalStore,approvalDigest} from '../../src/sites/async-approval-store.js';
import {approvalIdentityFields} from '../../src/production-approval-policy.js';
export {syntheticAdmin,approvalCommand} from './synthetic-approval.js';
export async function seedCloudApproval(f,packet,scope){
 const account={id:scope.accountId,workspace:scope.workspace,platform:f.sql.prepare('SELECT platform FROM sites_account_details WHERE account_id=?').get(scope.accountId).platform,external_id:'SYNTHETIC-PAGE',enabled:1};
 f.sql.prepare('UPDATE sites_account_details SET external_identity=? WHERE workspace=? AND account_id=?').run(account.external_id,scope.workspace,scope.accountId);
 const account_hash=await approvalDigest(Object.fromEntries(approvalIdentityFields.map(k=>[k,account[k]??null])));
 const binding={kind:'SYNTHETIC_FIXTURE',request_fingerprint:packet.request.request_fingerprint,result_fingerprint:await approvalDigest(packet.result),account,account_hash,workspace_kind:'synthetic',source_state:'SYNTHETIC_NO_EXTERNAL_SOURCE'};
 f.sql.prepare('INSERT INTO sites_approval_bindings VALUES(?,?)').run(packet.request.request_fingerprint,JSON.stringify(binding));return binding;
}
export async function approvalFixture(t,{video=false,platform='facebook'}={}){
 const x=await sitesEvidenceFixture(t);x.f.sql.prepare('UPDATE sites_account_details SET platform=? WHERE account_id=?').run(platform,x.accountId);const bucket=fileBucket(join(x.root,'objects')),packet=inspectedPacket(x.root,x.scope,{video,platformPayload:true,platform});
 const authorization={userId:'synthetic-owner',...x.scope},options={bucket,authorization,inspectionProvider:{readInspection:async()=>packet}},reviews=new AsyncReviewStore(x.f.db,options);
 await reviews.intake({...x.scope,task_id:packet.request.task_id,request_revision:1});await seedCloudApproval(x.f,packet,x.scope);
 return {...x,bucket,packet,id:packet.request.request_fingerprint,options,reviews,approvals:new AsyncApprovalStore(x.f.db,options)};
}
