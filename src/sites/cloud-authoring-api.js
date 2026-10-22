import {createSitesReadonlyApi} from './readonly-api.js';
import {createSitesScopeResolver} from './membership.js';
import {AsyncReviewStore} from './async-review-store.js';
import {AsyncApprovalStore} from './async-approval-store.js';
import {AsyncVariantEdits} from './async-variant-edits.js';
import {AsyncVariantReview} from './async-variant-review.js';
import {AsyncTargetReview} from './async-target-review.js';
import {AsyncUploadPlans} from './async-upload-plans.js';
import {requireProductionAdmin} from '../production-approval-policy.js';
import {AsyncMetricStore} from './async-metric-store.js';
import {authorizationGuard,authorizationChanged} from './async-storage.js';

export const cloudPlatforms=Object.freeze(['facebook','xiaohongshu','wechat_official_account','wechat_channels']);
const flags=Object.freeze({executionEnabled:false,publish_allowed:false,source_gate_satisfied:false,media_processing:'CLOUD_SERVICE_NOT_CONNECTED',producer_authenticated:false});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export async function cloudDigest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value)))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const fail=(code,status=409)=>{throw Object.assign(Error(code),{status});};
const exact=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail('INVALID_COMMAND',400);};
const text=(x,max)=>typeof x==='string'&&x.length>0&&x.length<=max&&x.trim()===x;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

async function readInput(request){
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')||''))fail('JSON_REQUIRED',415);
 const reader=request.body?.getReader();if(!reader)fail('INVALID_COMMAND',400);
 const chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072){await reader.cancel();fail('COMMAND_TOO_LARGE',413);}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_JSON',400);}
}

/** Portable Worker/D1 business boundary. No identity parser or fake hosted auth.
 * The official Sites server adapter supplies getTrustedIdentity per request.
 * Only server-resolved existing admins can decide/prepare synthetic review snapshots.
 * Publication, upload, credential and interaction routes stay shut.
 */
export function createCloudAuthoringApi({db,origin,getTrustedIdentity,bucket=null,resolveApprovalAuthority=null,targetReviewProvider=null,variantInspectionProvider=null,now=()=>new Date().toISOString()}={}){
 const statement=(sql,args=[])=>db.prepare(sql).bind(...args);
 async function rows(sql,args=[]){const result=await statement(sql,args).all();if(result.success===false||!Array.isArray(result.results))fail('STORAGE_UNAVAILABLE',503);return result.results;}
 async function one(sql,args=[]){return (await rows(sql,args))[0]||null;}
 async function owned(userId,workspace){if(!await one('SELECT id FROM sites_workspaces WHERE id=? AND owner_user_id=?',[workspace,userId]))fail('SCOPE_DENIED',403);}
 async function account(userId,workspace,accountId){await owned(userId,workspace);const a=await one("SELECT a.* FROM sites_account_details a JOIN sites_project_memberships m ON m.workspace=a.workspace AND m.account_id=a.account_id WHERE a.workspace=? AND a.account_id=? AND m.user_id=? AND m.role='READER' AND m.revoked_at IS NULL",[workspace,accountId,userId]);if(!a)fail('SCOPE_DENIED',403);return a;}
 async function assertCommandCompatible(userId,kind,input){const prior=await one('SELECT * FROM sites_authoring_commands WHERE owner_user_id=? AND command_id=?',[userId,input.command_id]);if(prior&&(prior.kind!==kind||prior.command_hash!==await cloudDigest({kind,input})))fail('COMMAND_CONFLICT');}
 async function command(userId,kind,input,makeStatements){
  if(!uuid(input.command_id))fail('INVALID_COMMAND_ID',400);
  const hash=await cloudDigest({kind,input}),prior=await one('SELECT * FROM sites_authoring_commands WHERE owner_user_id=? AND command_id=?',[userId,input.command_id]);
  if(prior){if(prior.command_hash!==hash||prior.kind!==kind)fail('COMMAND_CONFLICT');if(prior.committed!==1)fail('COMMAND_OUTCOME_UNKNOWN');return {id:prior.entity_id,duplicate:true};}
  const entityId=crypto.randomUUID(),at=now(),condition={userId,commandId:input.command_id,hash};
  // Every dependent INSERT selects the winning command's entity ID. Another
  // isolate can win the command key; no second side effect uses our losing UUID.
  const commands=[statement('INSERT INTO sites_authoring_commands(owner_user_id,command_id,kind,command_hash,entity_id,committed,created_at) VALUES(?,?,?,?,?,0,?) ON CONFLICT(owner_user_id,command_id) DO NOTHING',[userId,input.command_id,kind,hash,entityId,at]),...makeStatements(condition,at),...(kind==='WORKSPACE'?[]:[authorizationGuard(db,{userId,workspace:input.workspace,accountId:kind==='ACCOUNT'?null:input.account_id})]),statement('UPDATE sites_authoring_commands SET committed=1 WHERE owner_user_id=? AND command_id=? AND command_hash=? AND committed=0',[userId,input.command_id,hash]),statement('DELETE FROM sites_authorization_assertions')];
  try{const results=await db.batch(commands);if(!Array.isArray(results)||results.length!==commands.length||results.some(x=>x.success===false))fail('STORAGE_OUTCOME_UNCONFIRMED',503);}catch(error){if(error.status)throw error;if(authorizationChanged(error))fail('SCOPE_DENIED',403);fail('STORAGE_WRITE_REJECTED',409);}
  const receipt=await one('SELECT * FROM sites_authoring_commands WHERE owner_user_id=? AND command_id=?',[userId,input.command_id]);
  if(!receipt||receipt.command_hash!==hash||receipt.kind!==kind)fail('COMMAND_CONFLICT');if(receipt.committed!==1)fail('COMMAND_OUTCOME_UNKNOWN');return {id:receipt.entity_id,duplicate:receipt.entity_id!==entityId};
 }
 const winning=' FROM sites_authoring_commands c WHERE c.owner_user_id=? AND c.command_id=? AND c.command_hash=? AND c.committed=0';
 const bound=c=>[c.userId,c.commandId,c.hash];
 return async request=>{
  if(!db?.prepare||!db?.batch||!origin||typeof getTrustedIdentity!=='function')return response(503,{error:'SITES_RUNTIME_BINDING_REQUIRED',...flags});
  const url=new URL(request.url);if(url.origin!==origin)return response(409,{error:'HOST_MISMATCH'});
  try{
   const identity=await getTrustedIdentity(request);if(!identity||!text(identity.userId,300))fail('IDENTITY_REQUIRED',401);const userId=identity.userId;
   if(url.pathname.startsWith('/api/unified/'))return createSitesReadonlyApi({db,origin,resolveScope:createSitesScopeResolver({db,getTrustedIdentity:async()=>identity})})(request);
   if(!['GET','POST'].includes(request.method))fail('METHOD_NOT_ALLOWED',405);
   const revisedReview=url.pathname.match(/^\/api\/sites\/workspaces\/([a-f0-9-]{36})\/contents\/([a-f0-9-]{36})\/review$/);
   if(revisedReview){
    const [,workspace,id]=revisedReview,accountId=url.searchParams.get('accountId'),scope={workspace,accountId};await account(userId,workspace,accountId);
    if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);if(request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site')fail('ORIGIN_DENIED',403);
    const authority=typeof resolveApprovalAuthority==='function'?await resolveApprovalAuthority(request,identity,scope):null;
    return response(200,await new AsyncVariantReview(db,{bucket,variantInspectionProvider,authorization:{userId,workspace,accountId}}).create(id,await readInput(request),scope,{authority}));
   }
   const editRoute=url.pathname.match(/^\/api\/sites\/workspaces\/([a-f0-9-]{36})\/contents\/([a-f0-9-]{36})\/variants$/);
   if(editRoute){
    const [,workspace,id]=editRoute,accountId=url.searchParams.get('accountId'),scope={workspace,accountId};await account(userId,workspace,accountId);
    const edits=new AsyncVariantEdits(db,{bucket,authorization:{userId,workspace,accountId}});
    if(request.method==='GET'){const view=await edits.view(id,scope);let admin=false;try{requireProductionAdmin(typeof resolveApprovalAuthority==='function'?await resolveApprovalAuthority(request,identity,scope):null);admin=true;}catch{}
     return response(200,{...view,can_request_review:admin&&!!variantInspectionProvider?.inspectVariant&&view.content.account_id===accountId&&view.latest.id===id&&!!await one('SELECT 1 FROM sites_content_edits WHERE content_id=? AND source_plan_id IS NOT NULL',[id])});}
    if(request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site')fail('ORIGIN_DENIED',403);
    const input=await readInput(request),source=await edits.source(id,scope),authority=typeof resolveApprovalAuthority==='function'?await resolveApprovalAuthority(request,identity,{workspace,accountId:source.row.account_id}):null;
    return response(200,await edits.save(id,input,scope,{authority}));
   }
   const handoff=url.pathname.match(/^\/api\/sites\/workspaces\/([a-f0-9-]{36})\/(reviews|plans)\/([a-f0-9]{64})(?:\/(approval|prepare|retarget))?$/);
   if(handoff&&(handoff[2]==='plans'||handoff[4])){
    const [,workspace,resource,id,action]=handoff,accountId=url.searchParams.get('accountId'),scope={workspace,accountId};await account(userId,workspace,accountId);
    const options={bucket,authorization:{userId,workspace,accountId}},approvals=new AsyncApprovalStore(db,options),plans=new AsyncUploadPlans(db,options);
    // The resolver is installed by a server adapter, never by client input.
    const authority=typeof resolveApprovalAuthority==='function'?await resolveApprovalAuthority(request,identity,scope):null;let admin=false;try{requireProductionAdmin(authority);admin=true;}catch{}
    if(request.method==='POST'){
     if(request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site')fail('ORIGIN_DENIED',403);
     if(!admin)fail('APPROVAL_ADMIN_REQUIRED',403);const input=await readInput(request);
     if(resource==='reviews'&&action==='approval')return response(200,await approvals.decide(id,input,scope,{authority}));
     if(resource==='plans'&&action==='retarget'){
      const source=await one('SELECT account_id FROM sites_upload_plans WHERE id=? AND workspace=?',[id,workspace]);if(!source)fail('PRODUCTION_PLAN_NOT_FOUND');await account(userId,workspace,source.account_id);
      const sourceAuthority=await resolveApprovalAuthority(request,identity,{workspace,accountId:source.account_id});
      return response(200,await new AsyncTargetReview(db,{...options,targetReviewProvider}).create(id,input,scope,{authority,sourceAuthority}));
     }
     if(resource==='reviews'&&action==='prepare')return response(200,await plans.prepare(id,input,scope,{authority}));
     fail('METHOD_NOT_ALLOWED',405);
    }
    if(resource==='plans'&&!action){const p=await plans.view(id,scope);return response(200,{...p,can_request_target_review:admin&&!!targetReviewProvider?.readTargetBinding&&p.status==='UPLOAD_PREVIEW_ONLY'&&!await one('SELECT 1 FROM sites_review_derivations WHERE review_id=?',[p.review_id])});}
    if(resource==='reviews'&&action==='approval'){const approval=await approvals.view(id,scope,{admin});return response(200,{...approval,choices:approval.can_decide?await plans.choices(id,scope):[]});}
    fail('METHOD_NOT_ALLOWED',405);
   }
   const evidenceRoute=url.pathname.match(/^\/api\/sites\/workspaces\/([a-f0-9-]{36})\/(reviews|metrics)(?:\/([a-f0-9]{64})(?:\/(history|assets\/([^/]+)\/([^/]+)))?)?$/);
   if(evidenceRoute){
    if(request.method!=='GET')fail('METHOD_NOT_ALLOWED',405);const [,workspace,resource,id,tail,source,artifact]=evidenceRoute,accountId=url.searchParams.get('accountId');await account(userId,workspace,accountId);
    const authorization={userId,workspace,accountId};if(resource==='metrics'){const store=new AsyncMetricStore(db,{authorization});if(tail&&tail!=='history')fail('OPERATION_UNAVAILABLE',404);return response(200,id?(tail==='history'?await store.history(id,{workspace,accountId,before:url.searchParams.get('cursor')||''}):await store.snapshot(id,{workspace,accountId,...(url.searchParams.has('asOf')?{asOf:url.searchParams.get('asOf')}:{})})):await store.list(workspace,accountId,{cursor:url.searchParams.get('cursor')||'',...(url.searchParams.has('asOf')?{asOf:url.searchParams.get('asOf')}:{})}));}
    const store=new AsyncReviewStore(db,{bucket,authorization});if(tail==='history')fail('OPERATION_UNAVAILABLE',404);
    if(source){const asset=await store.asset(workspace,accountId,id,decodeURIComponent(source),decodeURIComponent(artifact));return new Response(asset.data,{headers:{'Content-Type':asset.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Length':String(asset.data.byteLength)}});}
    return response(200,id?await store.detail(workspace,accountId,id):await store.list(workspace,accountId,{cursor:url.searchParams.get('cursor')||''}));
   }
   if(request.method==='GET'&&url.pathname==='/api/sites/capabilities')return response(200,{...flags,mode:'SITES_CLOUD_AUTHORING',persistence:'D1',content_status:'MANUAL_UNVERIFIED',platforms:cloudPlatforms,implemented:['workspace_create','account_mapping_create','content_version_create','task_freeze','scoped_persistent_reads','review_snapshot_reads','metric_ledger_reads','content_decision_receipts','approved_platform_preparation','workspace_source_catalogue','explicit_platform_target_freeze','independent_target_review','single_platform_revision_edit','edited_version_inspection_review'],unavailable:['real_producer_transport','media_decode','archive_resolve','real_admin_approval_provider','external_upload','publish','group_post','reply','direct_message','live_metrics']});
   if(request.method==='GET'&&url.pathname==='/api/sites/workspaces')return response(200,{workspaces:await rows('SELECT id,name,created_at FROM sites_workspaces WHERE owner_user_id=? ORDER BY created_at,id LIMIT 200',[userId]),...flags});
   if(request.method==='POST'){
    if(request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site')fail('ORIGIN_DENIED',403);
    if(url.pathname==='/api/sites/workspaces'){
     const input=await readInput(request);exact(input,['command_id','name']);if(!text(input.name,120))fail('INVALID_NAME',400);
     const result=await command(userId,'WORKSPACE',input,(c,at)=>[statement('INSERT INTO sites_workspaces(id,owner_user_id,name,created_at) SELECT c.entity_id,c.owner_user_id,?,?'+winning+' ON CONFLICT(id) DO NOTHING',[input.name,at,...bound(c)])]);return response(200,{workspace_id:result.id,...result,...flags});
    }
   }
   const match=url.pathname.match(/^\/api\/sites\/workspaces\/([a-f0-9-]{36})\/(accounts|contents|catalogue|tasks)$/);if(!match)fail('OPERATION_UNAVAILABLE',404);
   const [,workspace,resource]=match;await owned(userId,workspace);
   if(request.method==='GET'){
    if(resource==='catalogue'){
     const viewer=url.searchParams.get('accountId');if(viewer!==null)await account(userId,workspace,viewer);
     // Shared source visibility is derived in the same SELECT as owner and active
     // source membership. An approval/plan remains bound to its original account.
     const contents=await rows(`SELECT c.*,p.id AS plan_id,p.account_id AS plan_account_id,e.source_plan_id AS edited_plan_id,(SELECT max(v.revision) FROM sites_contents v WHERE v.workspace=c.workspace AND v.account_id=c.account_id AND v.content_id=c.content_id AND v.slug=c.slug) AS latest_revision FROM sites_contents c
      JOIN sites_workspaces w ON w.id=c.workspace AND w.owner_user_id=?
      JOIN sites_project_memberships m ON m.workspace=c.workspace AND m.account_id=c.account_id AND m.user_id=? AND m.role='READER' AND m.revoked_at IS NULL
      LEFT JOIN sites_upload_plans p ON p.content_id=c.id AND p.workspace=c.workspace
      LEFT JOIN sites_content_edits e ON e.content_id=c.id
      WHERE c.workspace=? AND (? IS NULL OR EXISTS(SELECT 1 FROM sites_project_memberships v WHERE v.workspace=c.workspace AND v.account_id=? AND v.user_id=? AND v.role='READER' AND v.revoked_at IS NULL))
      ORDER BY c.created_at DESC,c.id DESC LIMIT 200`,[userId,userId,workspace,viewer,viewer,userId]);
     return response(200,{contents:contents.map(({variants_json,plan_id,plan_account_id,edited_plan_id,...c})=>({...c,variants:JSON.parse(variants_json),review_edit:edited_plan_id?{source_plan_id:edited_plan_id,requires_new_inspection:true}:null,review_binding:plan_id?{plan_id,account_id:plan_account_id}:null})),...flags});
    }
    if(resource==='accounts')return response(200,{accounts:await rows("SELECT a.* FROM sites_account_details a JOIN sites_project_memberships m ON m.workspace=a.workspace AND m.account_id=a.account_id WHERE a.workspace=? AND m.user_id=? AND m.role='READER' AND m.revoked_at IS NULL ORDER BY a.created_at,a.account_id LIMIT 200",[workspace,userId]),...flags});
    const accountId=url.searchParams.get('accountId');await account(userId,workspace,accountId);
    if(resource==='contents')return response(200,{contents:(await rows('SELECT * FROM sites_contents WHERE workspace=? AND account_id=? ORDER BY created_at DESC,id DESC LIMIT 200',[workspace,accountId])).map(c=>({...c,variants:JSON.parse(c.variants_json),variants_json:undefined})),...flags});
    return response(200,{tasks:(await rows('SELECT j.*,s.snapshot_json FROM publisher_jobs j JOIN sites_job_snapshots s ON s.job_id=j.id AND s.workspace=j.workspace WHERE j.workspace=? AND j.account_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT 200',[workspace,accountId])).map(j=>({...j,snapshot:JSON.parse(j.snapshot_json),snapshot_json:undefined,canExecute:false})),...flags});
   }
   if(resource==='catalogue')fail('METHOD_NOT_ALLOWED',405);
   const input=await readInput(request);
   if(resource==='accounts'){
    exact(input,['command_id','display_name','platform','external_identity']);if(!text(input.display_name,120)||!cloudPlatforms.includes(input.platform)||input.external_identity!==null&&!text(input.external_identity,200))fail('INVALID_ACCOUNT',400);
    const result=await command(userId,'ACCOUNT',{...input,workspace},(c,at)=>[
     statement('INSERT INTO facebook_accounts(id,workspace) SELECT c.entity_id,?'+winning+' ON CONFLICT(id) DO NOTHING',[workspace,...bound(c)]),
     statement("INSERT INTO sites_account_details SELECT ?,c.entity_id,?,?,?,'UNCONFIGURED',?"+winning+' ON CONFLICT(workspace,account_id) DO NOTHING',[workspace,input.display_name,input.platform,input.external_identity,at,...bound(c)]),
     statement("INSERT INTO sites_project_memberships SELECT c.owner_user_id,?,c.entity_id,'READER',NULL"+winning+' ON CONFLICT(user_id,workspace,account_id) DO NOTHING',[workspace,...bound(c)])
    ]);return response(200,{account_id:result.id,...result,...flags});
   }
   if(resource==='contents'){
    exact(input,['command_id','account_id','content_id','slug','revision','title','body','variants']);if(!uuid(input.command_id))fail('INVALID_COMMAND_ID',400);await account(userId,workspace,input.account_id);
    if(!/^[A-Z][A-Z0-9-]{3,80}$/.test(input.content_id||'')||!text(input.slug,120)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)||!Number.isSafeInteger(input.revision)||input.revision<1||input.revision>100000||!text(input.title,200)||!text(input.body,20000))fail('INVALID_CONTENT_VERSION',400);
    if(!input.variants||typeof input.variants!=='object'||Array.isArray(input.variants)||Object.keys(input.variants).length<1||Object.keys(input.variants).some(p=>!cloudPlatforms.includes(p)))fail('EXPLICIT_PLATFORM_VARIANT_REQUIRED',400);
    for(const value of Object.values(input.variants)){exact(value,['title','body']);if(!text(value.title,200)||!text(value.body,20000))fail('INVALID_PLATFORM_VARIANT',400);}
    const payloadHash=await cloudDigest({content_id:input.content_id,slug:input.slug,revision:input.revision,title:input.title,body:input.body,variants:input.variants});
    await assertCommandCompatible(userId,'CONTENT',{...input,workspace});
    const existing=await one('SELECT id,payload_hash FROM sites_contents WHERE workspace=? AND account_id=? AND content_id=? AND slug=? AND revision=?',[workspace,input.account_id,input.content_id,input.slug,input.revision]);
    if(existing){if(existing.payload_hash!==payloadHash)fail('CONTENT_VERSION_CONFLICT');return response(200,{id:existing.id,duplicate:true,...flags});}
    const result=await command(userId,'CONTENT',{...input,workspace},(c,at)=>[
     statement("INSERT INTO sites_contents SELECT c.entity_id,?,?,?,?,?,?,?,?,?,'MANUAL_UNVERIFIED',?"+winning,[workspace,input.account_id,input.content_id,input.slug,input.revision,input.title,input.body,JSON.stringify(input.variants),payloadHash,at,...bound(c)]),
     statement('INSERT INTO publisher_content_sources SELECT ?,?,?,c.entity_id,?'+winning,[workspace,input.account_id+'::'+input.content_id+'::'+input.slug,String(input.revision),payloadHash,...bound(c)])
    ]);return response(200,{...result,payload_hash:payloadHash,...flags});
   }
   const shared=Boolean(input&&Object.hasOwn(input,'expected_platform'));exact(input,['command_id','account_id','content_id','expected_payload_hash',...(shared?['expected_platform']:[])]);if(!uuid(input.command_id))fail('INVALID_COMMAND_ID',400);const a=await account(userId,workspace,input.account_id);
   if(shared&&input.expected_platform!==a.platform)fail('TARGET_PLATFORM_CHANGED');
   const content=await one('SELECT * FROM sites_contents WHERE workspace=? AND id=?'+(shared?'':' AND account_id=?'),[workspace,input.content_id,...(shared?[]:[input.account_id])]);
   if(!content)fail('CONTENT_NOT_FOUND',404);await account(userId,workspace,content.account_id);if(await one('SELECT 1 FROM sites_upload_plans WHERE content_id=? UNION ALL SELECT 1 FROM sites_content_edits WHERE content_id=? AND source_plan_id IS NOT NULL',[content.id,content.id]))fail('BOUND_REVIEW_TASK_REQUIRED');if(content.payload_hash!==input.expected_payload_hash)fail('CONTENT_CHANGED');const variant=JSON.parse(content.variants_json)[a.platform];if(!variant)fail('EXPLICIT_PLATFORM_VARIANT_REQUIRED');
   const snapshot={schema_version:1,workspace,account_id:a.account_id,platform:a.platform,external_identity:a.external_identity,content_id:content.content_id,slug:content.slug,revision:content.revision,content_row_id:content.id,payload_hash:content.payload_hash,payload:variant,media:[],source_status:content.source_status,publication_authority:'UNCONFIGURED'};
   if(content.account_id!==a.account_id)snapshot.source_account_id=content.account_id;
   await assertCommandCompatible(userId,'TASK',{...input,workspace});
   const snapshotHash=await cloudDigest(snapshot),existing=await one('SELECT id,state FROM publisher_jobs WHERE workspace=? AND account_id=? AND content_id=? AND snapshot_hash=?',[workspace,a.account_id,content.id,snapshotHash]);
   if(existing)return response(200,{id:existing.id,duplicate:true,state:existing.state,snapshot_hash:snapshotHash,...flags});
   const result=await command(userId,'TASK',{...input,workspace},(c,at)=>[
    authorizationGuard(db,{userId,workspace,accountId:content.account_id}),
    // Both source version and target identity are rechecked at the write boundary;
    // a reviewed plan can never be downgraded into an unapproved shared task.
    statement(`INSERT INTO sites_write_assertions(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM sites_contents s JOIN sites_account_details a ON a.workspace=s.workspace
     WHERE s.workspace=? AND s.id=? AND s.account_id=? AND s.content_id=? AND s.slug=? AND s.revision=? AND s.title=? AND s.body=? AND s.variants_json=? AND s.payload_hash=? AND s.source_status=?
     AND a.account_id=? AND a.platform=? AND a.external_identity IS ? AND NOT EXISTS(SELECT 1 FROM sites_upload_plans p WHERE p.content_id=s.id) AND NOT EXISTS(SELECT 1 FROM sites_content_edits e WHERE e.content_id=s.id AND e.source_plan_id IS NOT NULL)) THEN 1 ELSE 0 END`,[workspace,content.id,content.account_id,content.content_id,content.slug,content.revision,content.title,content.body,content.variants_json,content.payload_hash,content.source_status,a.account_id,a.platform,a.external_identity]),
    statement("INSERT INTO publisher_jobs SELECT c.entity_id,?,?,?,?,'DRAFT',NULL,?,?"+winning+' ON CONFLICT(id) DO NOTHING',[workspace,a.account_id,content.id,snapshotHash,at,at,...bound(c)]),
    statement('INSERT INTO sites_job_snapshots SELECT c.entity_id,?,?,?'+winning+' ON CONFLICT(job_id) DO NOTHING',[workspace,content.id,JSON.stringify(snapshot),...bound(c)]),
    statement('DELETE FROM sites_write_assertions')
   ]);return response(200,{...result,state:'DRAFT',snapshot_hash:snapshotHash,...flags});
  }catch(error){const known={'STORAGE_SCOPE_DENIED':403,'METRIC_NOT_FOUND':404,'REVIEW_NOT_FOUND':404,'REVIEW_ASSET_NOT_FOUND':404,'OBJECT_NOT_FOUND':404,'METRIC_CURSOR_INVALID':400,'METRIC_AS_OF_INVALID':400,'REVIEW_CURSOR_INVALID':400,'OBJECT_MISSING':503,'OBJECT_IO_TIMEOUT':503,'OBJECT_CORRUPT':503,'OBJECT_INTEGRITY_MISMATCH':503,'R2_BINDING_REQUIRED':503,'REVIEW_STORAGE_CORRUPT':503,'METRIC_STORAGE_CORRUPT':503},handoffError=/^(VARIANT_|APPROVAL_|PRODUCTION_|PRODUCER_AUTH_UNAVAILABLE|ACCOUNT_TARGET_CHANGED|STALE_REVIEW_VERSION|SOURCE_PROVIDER_UNAVAILABLE|SYNTHETIC_PROVENANCE_INVALID|TARGET_IDENTITY_UNKNOWN|ENTERPRISE_SOURCE_APPROVAL_FORBIDDEN)/.test(error.message),status=error.status||known[error.message]||(handoffError?409:503);return response(status,{error:error.status||known[error.message]||handoffError?error.message:'SITES_STORAGE_UNAVAILABLE',...flags});}
 };
}
