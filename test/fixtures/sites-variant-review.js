import {targetReviewFixture} from './sites-target-review.js';
import {AsyncVariantEdits} from '../../src/sites/async-variant-edits.js';
import {AsyncVariantReview} from '../../src/sites/async-variant-review.js';
import {createCloudAuthoringApi} from '../../src/sites/cloud-authoring-api.js';
import {syntheticAdmin} from './sites-approval.js';
import {syntheticVariantInspector} from './sites-variant-inspector.js';
export async function variantReviewFixture(t,options={}){
 const x=await targetReviewFixture(t,options),edits=new AsyncVariantEdits(x.f.db,x.options),base=await edits.view(x.plan.content_id,x.scope);
 const saveInput={command_id:crypto.randomUUID(),expected_payload_hash:base.content.payload_hash,expected_source_binding:base.source_binding_hash,platform:'facebook',title:'新版本明确标题',body:'新版本完整正文。\n完整末段保留。'};
 const saved=await edits.save(base.content.id,saveInput,x.scope,{authority:syntheticAdmin}),view=await edits.view(saved.id,x.scope),inspector=syntheticVariantInspector(x.root),reviewOptions={...x.options,variantInspectionProvider:inspector},revisions=new AsyncVariantReview(x.f.db,reviewOptions),input={command_id:crypto.randomUUID(),expected_payload_hash:saved.payload_hash,expected_source_binding:view.source_binding_hash};
 const api=createCloudAuthoringApi({db:x.f.db,origin:x.f.origin,bucket:x.bucket,getTrustedIdentity:async()=>({userId:'synthetic-owner'}),resolveApprovalAuthority:async()=>syntheticAdmin,variantInspectionProvider:inspector});
 const create=(body=input)=>revisions.create(saved.id,body,x.scope,{authority:syntheticAdmin});
 return {...x,edits,base,saved,view,saveInput,inspector,reviewOptions,revisions,input,api,create};
}
