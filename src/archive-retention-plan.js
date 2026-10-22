/** Planning only. Global permanent-deletion pause cannot be disabled here. */
export function archiveRetentionPlan(inventory,{now=Date.now()}={}){
 if(!Number.isFinite(now)||!Array.isArray(inventory)||inventory.length>100000)throw Error('RETENTION_INVENTORY_INVALID');
 const groups=new Map(),seen=new Set();
 for(const row of inventory){
  if(!row||!['ORIGINAL_MEDIA','ARCHIVE','LEDGER'].includes(row.kind)||['project_id','library_id','file_id'].some(k=>typeof row[k]!=='string'||!row[k]||row[k].length>200))throw Error('RETENTION_INVENTORY_INVALID');
  const scope=JSON.stringify([row.project_id,row.library_id]),identity=JSON.stringify([row.project_id,row.library_id,row.file_id]);
  if(seen.has(identity))throw Error('RETENTION_DUPLICATE_IDENTITY');seen.add(identity);
  if(row.kind!=='ORIGINAL_MEDIA')continue;
  if(!groups.has(scope))groups.set(scope,[]);groups.get(scope).push(row);
 }
 const protected_files=[],outside_latest20=[],technical_candidates=[];
 for(const rows of groups.values()){
  const invalid=rows.some(r=>typeof r.original_media_timestamp!=='string'||!Number.isFinite(Date.parse(r.original_media_timestamp))||Date.parse(r.original_media_timestamp)>now||new Date(r.original_media_timestamp).toISOString()!==r.original_media_timestamp);
  // Original media timestamps only. Archive creation and ledger/update times have no influence.
  rows.sort((a,b)=>String(b.original_media_timestamp).localeCompare(String(a.original_media_timestamp))||a.file_id.localeCompare(b.file_id));
  // Protect all ties at the twentieth file, so a tie-break never permits deletion.
  const cutoff=rows[19]?.original_media_timestamp;
  for(const row of rows){const identity={project_id:row.project_id,library_id:row.library_id,file_id:row.file_id};
   if(invalid||rows.length<=20||row.original_media_timestamp>=cutoff)protected_files.push({...identity,reason:invalid?'ORIGINAL_TIMESTAMP_UNCERTAIN':'LATEST_20_OR_TIED'});
   else{outside_latest20.push(identity);if(allVideoTargetsReadBack(row,now))technical_candidates.push({...identity,reason:'DECLARED_ALL_VIDEO_TARGETS_READ_BACK',requires_explicit_batch_confirmation:true});}
  }
 }
 return {permanent_deletion_paused:true,protected_files,outside_latest20,technical_candidates,deletion_candidates:[],delete_allowed:false,evidence_authentication:'CALLER_SUPPLIED_NOT_AUTHENTICATED',consumer_acceptance:'PUBLISHER_AND_MUSE_LIVE_UNVERIFIED'};
}

function allVideoTargetsReadBack(row,now){
 if(row.media_type!=='VIDEO'||typeof row.content_id!=='string'||!row.content_id||typeof row.content_revision!=='string'||!row.content_revision||!Array.isArray(row.publication_targets)||!row.publication_targets.length||!Array.isArray(row.publication_evidence))return false;
 const identities=new Set();
 for(const target of row.publication_targets){
  if(!target||['platform','account_id','job_id'].some(k=>typeof target[k]!=='string'||!target[k]))return false;
  const identity=JSON.stringify([target.platform,target.account_id]);if(identities.has(identity))return false;identities.add(identity);
  const matches=row.publication_evidence.filter(e=>e&&e.project_id===row.project_id&&e.platform===target.platform&&e.account_id===target.account_id&&e.job_id===target.job_id&&e.content_id===row.content_id&&e.content_revision===row.content_revision);
  if(!matches.length||matches.some(e=>typeof e.observed_at!=='string'||!Number.isFinite(Date.parse(e.observed_at))||Date.parse(e.observed_at)>now||new Date(e.observed_at).toISOString()!==e.observed_at))return false;
  matches.sort((a,b)=>b.observed_at.localeCompare(a.observed_at));const latest=matches.filter(e=>e.observed_at===matches[0].observed_at);
  if(latest.some(e=>e.status!=='PUBLISHED'||e.source!=='LIVE_PLATFORM_READBACK'||e.readback_verified!==true||typeof e.platform_object_id!=='string'||!e.platform_object_id))return false;
  if(new Set(latest.map(e=>e.platform_object_id)).size!==1)return false;
 }
 return true;
}
