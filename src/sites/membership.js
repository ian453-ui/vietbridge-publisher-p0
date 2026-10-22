/** Supply getTrustedIdentity from the official server-only Sites auth integration.
 * This module never interprets browser headers, email, body or member claims as
 * identity. Membership records must be provisioned by an authorized operator or
 * explicit owner-scoped account creation; no first-visitor global enrollment or
 * grant-to-another-user HTTP endpoint exists.
 */
export function createSitesScopeResolver({db,getTrustedIdentity}={}) {
  if(!db?.prepare||typeof getTrustedIdentity!=='function')throw Error('SITES_IDENTITY_BINDING_REQUIRED');
  return async request=>{
    const identity=await getTrustedIdentity(request);
    if(!identity||typeof identity.userId!=='string'||!identity.userId.trim())return null;
    const url=new URL(request.url),route=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/(jobs|source-ledger)$/);
    if(!route)throw Error('SCOPE_DENIED');
    const workspace=decodeURIComponent(route[1]),accountId=url.searchParams.get('accountId');
    if(!accountId)throw Error('SCOPE_DENIED');
    const result=await db.prepare(`SELECT m.account_id FROM sites_project_memberships m JOIN facebook_accounts a ON a.workspace=m.workspace AND a.id=m.account_id WHERE m.user_id=? AND m.workspace=? AND m.account_id=? AND m.role='READER' AND m.revoked_at IS NULL`).bind(identity.userId,workspace,accountId).all();
    if(result.success===false||!Array.isArray(result.results)||result.results.length!==1||result.results[0].account_id!==accountId)throw Error('SCOPE_DENIED');
    return {userId:identity.userId,workspace,accountIds:[accountId]};
  };
}
