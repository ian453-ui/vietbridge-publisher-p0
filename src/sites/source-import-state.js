// Shared read/approval guard for source observations. No transport or authority.

export async function sourceImportState(store,id){
 const row=await store.one('SELECT b.source_key,b.source_revision,b.descriptor_hash,h.source_revision current_revision,h.descriptor_hash current_hash,h.state,h.reason,h.attempt_id,h.summary_json FROM sites_review_sources b JOIN sites_source_heads h ON h.source_key=b.source_key WHERE b.review_id=?',[id]);
 if(!row)return {required:false,blocked:null};
 const blocked=row.state!=='IMPORTED'?(row.reason||'SOURCE_IMPORT_PENDING'):row.source_revision!==row.current_revision||row.descriptor_hash!==row.current_hash?'SOURCE_VERSION_CHANGED':null;
 return {...row,required:true,blocked};
}
