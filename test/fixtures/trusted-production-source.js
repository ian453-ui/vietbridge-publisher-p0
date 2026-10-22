import {ProductionSourceEvidence} from '../../src/production-source-evidence.js';
import {syntheticAdmin,approvalCommand} from './synthetic-approval.js';

// The only trusted-provider implementation is a test fixture. No runtime factory, env switch or HTTP registration.
export function trustedSourceFixture(f,{now=()=>Date.now(),timeoutMs=2000,maxAgeMs=300000}={}){
 const db=f.store.db,id=f.reviewId,scope=f.scope,request=JSON.parse(f.reviews.approvals.row(id,scope).request_json);
 const config={review_id:id,workspace:scope.workspace,account_id:scope.accountId,provider_id:'synthetic_test',task_reference:request.bridge_ref,submission_reference:'test-only-submission-1',task_author:{issuer:'fixture',subject:'original-task-owner'},producer:{issuer:'fixture',subject:'synthetic-producer'},approvers:[{issuer:'fixture',subject:'synthetic-approver'}],max_age_ms:maxAgeMs};
 let snapshot,read=async()=>Buffer.from(JSON.stringify({...snapshot,observed_at:now()})),calls=0;
 const provider={readSnapshot:async input=>{calls++;return read(input);}},options={providers:{synthetic_test:provider},bindings:[config],timeoutMs,now},service=new ProductionSourceEvidence(db,options),expected=service.expected(id,scope);
 snapshot={schema_version:1,provider_id:config.provider_id,observed_at:now(),history_complete:true,task:{reference:config.task_reference,author:config.task_author,request:expected.request},submission:{reference:config.submission_reference,author:config.producer,task_reference:config.task_reference,result:expected.result},decisions:[{id:'fixture-approve-1',sequence:1,kind:'APPROVED',author:config.approvers[0],binding_hash:expected.binding_hash,decided_at:now()}]};
 const verify=()=>service.verify(id,{expected_subject:expected.binding.subject_fingerprint},scope,{authority:syntheticAdmin});
 const approve=()=>{const view=f.reviews.approvals.view(id,scope,{admin:true,now:now()});return f.reviews.approvals.decide(id,approvalCommand(view),scope,{authority:syntheticAdmin,now:now()});};
 return {service,options,config,expected,verify,approve,provider,get calls(){return calls;},get snapshot(){return snapshot;},set read(value){read=value;},raw:()=>Buffer.from(JSON.stringify({...snapshot,observed_at:now()})),revoke(){snapshot.decisions.push({...snapshot.decisions[0],id:'fixture-revoke-'+(snapshot.decisions.length+1),sequence:snapshot.decisions.length+1,kind:'REVOKED',decided_at:now()});}};
}
