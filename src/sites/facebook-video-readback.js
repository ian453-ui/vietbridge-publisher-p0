import {digest,sha256} from './async-storage.js';
import {verifiedFacebookVideo} from '../facebook-video-evidence.js';
const fail=code=>{throw Object.assign(Error(code),{code,next_action:'RECONCILE_PENDING',absenceProven:false});};
const id=x=>typeof x==='string'&&/^[1-9]\d{0,39}$/.test(x);
const text=x=>typeof x==='string'&&x.length>0&&x.length<=300;
const fields='id,title,description,published,status,permalink_url,from';
function canonicalLink(raw,videoId){
 if(typeof raw!=='string'||raw.length>2048)return null;
 let u;try{u=new URL(raw,'https://www.facebook.com');}catch{return null;}
 if(u.protocol!=='https:'||!['facebook.com','www.facebook.com'].includes(u.hostname)||u.username||u.password||u.port)return null;
 const path=u.pathname,watch=path==='/watch/'||path==='/watch';
 if(watch&&u.searchParams.get('v')===videoId)return 'https://www.facebook.com/watch/?v='+videoId;
 if(new RegExp('^/(?:reel|[A-Za-z0-9.-]+/videos)/'+videoId+'/?$').test(path))return 'https://www.facebook.com'+path;
 return null;
}
function deadline(ms){
 const controller=new AbortController();let timer;
 const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('READBACK_DEADLINE'),{code:'READBACK_DEADLINE'}));},ms);});
 return {signal:controller.signal,run:fn=>Promise.race([Promise.resolve().then(fn),expired]),close(){clearTimeout(timer);controller.abort();}};
}
/** Worker-compatible READ ONLY protocol. No token discovery/refresh, file/env
 * credentials, issuer, default provider, send method or HTTP route exists.
 * Provider MUST independently look up the original job/attempt/receipt and read
 * authority in the existing trusted store; request data is never that authority.
 * Provider and request injection are server dependencies (tests use loopback).
 */
export class FacebookVideoReadback {
 constructor({provider=null,request=globalThis.fetch,timeoutMs=10000,maxBytes=262144}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>262144)fail('READBACK_LIMIT_INVALID');
  this.provider=provider;this.request=request;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;
 }
 async readback(snapshot,receipt){
  if(!this.provider?.resolveReadback||!this.provider?.revalidateReadback)fail('READBACK_PROVIDER_UNAVAILABLE');
  // Copy before awaits: mutable caller objects cannot change frozen expectations.
  let s;try{s=structuredClone(snapshot);}catch{fail('READBACK_INPUT_INVALID');}
  const objectId=receipt?.id;
  if(!id(objectId)||!text(s?.workspace)||!text(s.accountId)||s.platform!=='facebook'||!id(s.operatorActorId)||!id(s.targetPageId)||s.externalId!==s.operatorActorId||s.media?.length!==1||typeof s.media[0]!=='string'||!s.media[0].toLowerCase().endsWith('.mp4')||typeof s.title!=='string'||typeof s.body!=='string'||!/^[a-f0-9]{64}$/.test(s.contentHash||''))fail('READBACK_INPUT_INVALID');
  const encoded=JSON.stringify(s);if(new TextEncoder().encode(encoded).length>262144)fail('READBACK_INPUT_LIMIT');
  const binding=Object.freeze({operation:'FACEBOOK_VIDEO_READBACK',workspace:s.workspace,account_id:s.accountId,operator_actor_id:s.operatorActorId,target_page_id:s.targetPageId,snapshot_hash:await sha256(encoded),object_id:objectId}),d=deadline(this.timeoutMs);let consumed=0;
  try{
   let grant;try{grant=structuredClone(await d.run(()=>this.provider.resolveReadback(binding,{signal:d.signal})));}catch(e){if(e.code==='READBACK_DEADLINE')throw e;fail('READBACK_AUTHORITY_UNAVAILABLE');}
   if(!grant||Object.keys(binding).some(k=>grant.binding?.[k]!==binding[k])||Object.keys(grant.binding||{}).length!==Object.keys(binding).length||!text(grant.job_id)||!text(grant.attempt_id)||!text(grant.authorization_revision)||!Number.isSafeInteger(grant.expires_at)||grant.expires_at<=Date.now()||!/^v[1-9]\d{0,2}\.0$/.test(grant.api_version||'')||grant.credential?.kind!=='PAGE_ACCESS_TOKEN'||typeof grant.credential.value!=='string'||!grant.credential.value||grant.credential.value.length>4096||/[\s\x00-\x1f\x7f]/.test(grant.credential.value))fail('READBACK_AUTHORITY_MISMATCH');
   const proof=Object.freeze({...binding,job_id:grant.job_id,attempt_id:grant.attempt_id,authorization_revision:grant.authorization_revision});
   const revalidate=async()=>{let current;try{current=await d.run(()=>this.provider.revalidateReadback(proof,{signal:d.signal}));}catch(e){if(e.code==='READBACK_DEADLINE')throw e;fail('READBACK_AUTHORITY_UNAVAILABLE');}if(current!==true||grant.expires_at<=Date.now())fail('READBACK_AUTHORITY_CHANGED');};
   const get=async(path,requested)=>{
    await revalidate();const url=new URL('https://graph.facebook.com/'+grant.api_version+'/'+path);url.searchParams.set('fields',requested);let response;
    try{response=await d.run(()=>this.request(url.href,{method:'GET',headers:{Authorization:'Bearer '+grant.credential.value,Accept:'application/json'},redirect:'error',signal:d.signal}));}catch(e){if(e.code==='READBACK_DEADLINE')throw e;fail('READBACK_TRANSPORT_UNAVAILABLE');}
    const stop=()=>{try{void response.body?.cancel().catch(()=>{});}catch{}};
    if(response.redirected||response.status>=300&&response.status<400){stop();fail('READBACK_REDIRECT_REJECTED');}
    // No platform error text/body is exposed or retained, even if it echoes secrets.
    if(!response.ok){stop();fail('READBACK_HTTP_'+(Number.isSafeInteger(response.status)?response.status:0));}
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>this.maxBytes-consumed)){stop();fail('READBACK_RESPONSE_LIMIT');}
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||!response.body?.getReader){stop();fail('READBACK_RESPONSE_INVALID');}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const part=await d.run(()=>reader.read());if(part.done)break;if(!(part.value instanceof Uint8Array))fail('READBACK_RESPONSE_INVALID');size+=part.value.byteLength;consumed+=part.value.byteLength;if(consumed>this.maxBytes)fail('READBACK_RESPONSE_LIMIT');chunks.push(part.value);}}
    finally{try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
    const data=new Uint8Array(size);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}
    let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{fail('READBACK_RESPONSE_INVALID');}
    if(!value||Array.isArray(value)||typeof value!=='object'||value.error)fail('READBACK_GRAPH_ERROR');return value;
   };
   const identity=await get('me','id');if(identity.id!==s.targetPageId)fail('READBACK_PAGE_MISMATCH');
   const result=await get(objectId,fields),url=canonicalLink(result.permalink_url,objectId);
   if(!url||typeof result.title!=='string'||typeof result.description!=='string'||!verifiedFacebookVideo({...result,permalink_url:url},objectId,s.targetPageId,s.title,s.body))fail('READBACK_VIDEO_UNCONFIRMED');
   await revalidate();
   const observed={id:result.id,from:{id:result.from.id},title:result.title,description:result.description,published:true,status:{video_status:'ready'},permalink_url:url};
   return {verified:true,id:objectId,url,pageId:s.targetPageId,targetPageId:s.targetPageId,operatorActorId:s.operatorActorId,contentHash:s.contentHash,payloadHash:s.payloadHash,method:'API_VIDEO_INDEPENDENT_READBACK',identityEvidence:'API_TARGET_PAGE_AUTH',readbackBinding:proof,observed_at:new Date().toISOString(),evidence_sha256:await digest(observed),observation:observed,mediaBytesVerified:false,absenceProven:false};
  }catch(e){if(/^READBACK_[A-Z0-9_]+$/.test(e?.code||''))fail(e.code);fail('READBACK_UNAVAILABLE');}finally{d.close();}
 }
}
