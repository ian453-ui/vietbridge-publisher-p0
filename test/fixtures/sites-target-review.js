import {approvalFixture,syntheticAdmin,approvalCommand} from './sites-approval.js';
import {AsyncUploadPlans} from '../../src/sites/async-upload-plans.js';
import {createCloudAuthoringApi} from '../../src/sites/cloud-authoring-api.js';
// Server dependency ONLY installed by tests. No production provider or credentials.
export const syntheticTargetProvider=db=>({async readTargetBinding(ref){
 const a=(await db.prepare('SELECT * FROM sites_account_details WHERE workspace=? AND account_id=?').bind(ref.workspace,ref.accountId).all()).results[0];
 return {...ref,kind:'SYNTHETIC_FIXTURE',workspace_kind:'synthetic',source_state:'SYNTHETIC_NO_EXTERNAL_SOURCE',account:{id:a.account_id,workspace:a.workspace,platform:a.platform,external_id:a.external_identity,enabled:1}};
}});
export async function targetReviewFixture(t,{video=false,sourceRefs=[]}={}){
 const x=await approvalFixture(t,{video,sourceRefs}),v=await x.approvals.view(x.id,x.scope),a=await x.approvals.decide(x.id,approvalCommand(v),x.scope,{authority:syntheticAdmin}),plans=new AsyncUploadPlans(x.f.db,x.options);
 const plan=await plans.prepare(x.id,{expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id,source_id:x.packet.request.items[0].source_id,payload_artifact_id:'platform'},x.scope,{authority:syntheticAdmin});
 const target=(await x.post('/api/sites/workspaces/'+x.workspace+'/accounts',{display_name:'Independent target',platform:'facebook',external_identity:'SYNTHETIC-SECOND-PAGE'})).id;
 const targetScope={workspace:x.workspace,accountId:target},targetOptions={...x.options,authorization:{userId:'synthetic-owner',...targetScope},targetReviewProvider:syntheticTargetProvider(x.f.db)};
 const api=createCloudAuthoringApi({db:x.f.db,origin:x.f.origin,bucket:x.bucket,getTrustedIdentity:async()=>({userId:'synthetic-owner'}),resolveApprovalAuthority:async()=>syntheticAdmin,targetReviewProvider:targetOptions.targetReviewProvider});
 const input={command_id:crypto.randomUUID(),expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id,expected_platform:'facebook'};
 const call=async(body=input,scope=targetScope,handler=api)=>{const r=await handler(new Request(x.f.origin+'/api/sites/workspaces/'+scope.workspace+'/plans/'+plan.id+'/retarget?accountId='+scope.accountId,{method:'POST',headers:{origin:x.f.origin,'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};};
 return {...x,plan,target,targetScope,targetOptions,input,call,api};
}
