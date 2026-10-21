/** Portable, read-only D1 boundary. Not a deployment entry or identity provider.
 * resolveScope must use trusted Sites identity AND server-side workspace/account
 * membership. Never implement it using request headers/query parameters alone.
 * No Store/Executor construction, migration, claim, recovery or R2 access here.
 */
export function createSitesReadonlyApi({db,origin,resolveScope}={}) {
  const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
  return async request=>{
    if(!db?.prepare||typeof resolveScope!=='function'||!origin)return response(503,{error:'SITES_BINDING_NOT_CONFIGURED'});
    const url=new URL(request.url);
    if(url.origin!==origin)return response(409,{error:'HOST_MISMATCH'});
    // Every mutation is denied before storage, including approve/reconcile/retry.
    if(request.method!=='GET')return response(405,{error:'SITES_READ_ONLY'});
    let scope;
    try {scope=await resolveScope(request);}catch {return response(403,{error:'SCOPE_DENIED'});}
    if(!scope?.userId)return response(401,{error:'IDENTITY_REQUIRED'});
    const route=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/(jobs|source-ledger)$/);
    if(!route)return response(404,{error:'NOT_FOUND'});
    let workspace;
    try {workspace=decodeURIComponent(route[1]);}catch{return response(400,{error:'INVALID_PATH'});}
    const account=url.searchParams.get('accountId');
    if(!account||workspace!==scope.workspace||!Array.isArray(scope.accountIds)||!scope.accountIds.includes(account))return response(403,{error:'SCOPE_DENIED'});
    const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100;
    const offset=url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||offset>10000)return response(400,{error:'INVALID_PAGINATION'});
    try {
      // Same original tables, scope and deterministic ordering. Deliberately no
      // snapshot/evidence/credential blobs in this initial read-only projection.
      const sql=route[2]==='jobs'
        ? `SELECT j.id,j.workspace,j.account_id,j.content_id,j.snapshot_hash,j.state,j.attempt_id,j.created_at,j.updated_at FROM publisher_jobs j JOIN facebook_accounts a ON a.id=j.account_id AND a.workspace=j.workspace WHERE j.workspace=? AND j.account_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT ? OFFSET ?`
        : `SELECT s.workspace,s.source_id,s.revision,s.content_id,s.payload_hash FROM publisher_content_sources s WHERE s.workspace=? AND EXISTS (SELECT 1 FROM publisher_jobs j JOIN facebook_accounts a ON a.id=j.account_id AND a.workspace=j.workspace WHERE j.workspace=s.workspace AND j.content_id=s.content_id AND j.account_id=?) ORDER BY s.source_id,s.revision,s.content_id LIMIT ? OFFSET ?`;
      const result=await db.prepare(sql).bind(workspace,account,limit,offset).all();
      if(result.success===false||!Array.isArray(result.results))throw Error('READ_FAILED');
      return response(200,{mode:'SITES_READ_ONLY',executionEnabled:false,transactionWritesSupported:false,
        [route[2]==='jobs'?'jobs':'sources']:result.results.map(row=>route[2]==='jobs'?{...row,canExecute:false,execution:{canExecute:false,mode:'DISABLED'}}:row)});
    }catch{return response(503,{error:'SITES_STORAGE_UNAVAILABLE'});}
  };
}
