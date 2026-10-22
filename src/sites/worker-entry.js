import {createCloudAuthoringApi} from './cloud-authoring-api.js';

export const PUBLISHER_SITE_PROJECT_ID='appgprj_6ad97a034fd08191a8399eeda10f048c';
const assets=new Map([
 ['/',{path:'/cloud-console.html',type:'text/html; charset=utf-8',mime:['text/html']}],
 ['/cloud-console.js',{path:'/cloud-console.js',type:'text/javascript; charset=utf-8',mime:['text/javascript','application/javascript']}],
 ['/cloud-console.css',{path:'/cloud-console.css',type:'text/css; charset=utf-8',mime:['text/css']}],
]);
const security={
 'Cache-Control':'private, no-store',
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
 'Vary':'Cookie',
};
const error=(status,code,extra={})=>new Response(JSON.stringify({error:code,executionEnabled:false,publish_allowed:false}),{status,headers:{...security,'Content-Type':'application/json; charset=utf-8',...extra}});
function canonicalOrigin(value,allowLoopback){
 try{
  const u=new URL(value);
  if(u.origin!==value||u.username||u.password)return null;
  if(u.protocol==='https:'||allowLoopback&&u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))return u.origin;
 }catch{}
 return null;
}

/** Application adapter, not an invented Sites auth implementation or build helper.
 * Official server code must supply getTrustedIdentity. Never source that function
 * from request headers/body, service tokens or a browser-selectable environment.
 * DB/BUCKET/ASSETS are request-local runtime bindings, never global data stores.
 * Hosting must route protected assets through this handler (Worker-first), or
 * provide readAsset from the official framework's server-side asset integration.
 */
export function createPublisherSite({origin=null,getTrustedIdentity=null,readAsset=null,resolveApprovalAuthority=null,targetReviewProvider=null,variantInspectionProvider=null,allowLoopback=false}={}){
 return {async fetch(request,env={},ctx){
  try{
   const expected=canonicalOrigin(origin??env.PUBLISHER_CANONICAL_ORIGIN,allowLoopback);
   if(!expected)return error(503,'SITES_ORIGIN_REQUIRED');
   const url=new URL(request.url);
   if(url.origin!==expected)return error(409,'HOST_MISMATCH');
   const asset=assets.get(url.pathname),api=url.pathname.startsWith('/api/sites/')||url.pathname.startsWith('/api/unified/');
   if(!asset&&!api)return error(404,'OPERATION_UNAVAILABLE');
   if(asset&&!['GET','HEAD'].includes(request.method)||api&&!['GET','POST'].includes(request.method))return error(405,'METHOD_NOT_ALLOWED',{'Allow':asset?'GET, HEAD':'GET, POST'});
   // Even the document fails closed: a static shell is not a working backend.
   if(typeof env.DB?.prepare!=='function'||typeof env.DB?.batch!=='function')return error(503,'SITES_RUNTIME_BINDING_REQUIRED');
   if(env.BUCKET!=null&&(typeof env.BUCKET.get!=='function'||typeof env.BUCKET.put!=='function'))return error(503,'R2_BINDING_REQUIRED');
   if(typeof getTrustedIdentity!=='function')return error(503,'SITES_IDENTITY_INTEGRATION_UNAVAILABLE');
   let identity;
   try{identity=await getTrustedIdentity(request,env,ctx);}catch{return error(503,'SITES_IDENTITY_PROVIDER_UNAVAILABLE');}
   if(!identity||typeof identity.userId!=='string'||!identity.userId.length||identity.userId.length>300||identity.userId.trim()!==identity.userId)return error(401,'IDENTITY_REQUIRED');
   // Capture only this resolved identity for this request; do not parse headers.
   const trustedIdentity=Object.freeze({userId:identity.userId});
   if(api){
    const handler=createCloudAuthoringApi({db:env.DB,bucket:env.BUCKET??null,origin:expected,getTrustedIdentity:async()=>trustedIdentity,
     resolveApprovalAuthority:typeof resolveApprovalAuthority==='function'?(req,user,scope)=>resolveApprovalAuthority(req,user,scope,env,ctx):null,
     targetReviewProvider,variantInspectionProvider});
    return await handler(request);
   }
   const loader=typeof readAsset==='function'?()=>readAsset(asset.path,{request,env,ctx}):typeof env.ASSETS?.fetch==='function'?()=>env.ASSETS.fetch(new Request(new URL(asset.path,expected),{method:'GET'})):null;
   if(!loader)return error(503,'SITES_ASSET_BINDING_REQUIRED');
   let response;
   try{response=await loader();}catch{return error(503,'SITES_ASSET_UNAVAILABLE');}
   // Reject SPA fallbacks, redirects and the wrong content type; never expose an
   // arbitrary asset directory or forward cookies/headers to an asset provider.
   if(!(response instanceof Response)||response.status!==200||!asset.mime.includes((response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase()))return error(503,'SITES_ASSET_INVALID');
   return new Response(request.method==='HEAD'?null:response.body,{headers:{...security,'Content-Type':asset.type}});
  }catch{return error(503,'SITES_APPLICATION_UNAVAILABLE');}
 }};
}

// Safe importable Worker entry. Without the official identity integration this
// intentionally refuses service. The official starter must import the factory
// above and supply its own server-only auth helper before a real deployment.
export default createPublisherSite();
