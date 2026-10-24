const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=code=>{throw Error(code);};

/** Server-only transport. Callers must perform official Sites identity,
 * membership, QA, frozen-source and explicit publication checks first.
 * A token is never returned or placed in an asset/browser response.
 */
export class MacExecutionRelayClient {
 constructor({origin,token,fetchImpl=fetch,timeoutMs=15000}={}){
  let parsed;try{parsed=new URL(origin);}catch{fail('V3_RELAY_ORIGIN_REQUIRED');}
  if(parsed.origin!==origin||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hostname!=='publisher.vietbridge.one'||!/^vb_app_[A-Za-z0-9_-]{40,}$/.test(token||'')||typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)fail('V3_RELAY_CONFIGURATION_INVALID');
  this.origin=origin;this.token=token;this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs;
 }
 async call(siteJobId,operation,input){
  if(!uuid(siteJobId)||!['status','capability','dispatch','reconcile'].includes(operation))fail('V3_RELAY_COMMAND_INVALID');
  const method=['status','capability'].includes(operation)?'GET':'POST';
  if(method==='POST'&&(!input||!sha(input.local_snapshot_hash)||!sha(input.site_snapshot_hash)))fail('V3_RELAY_HASH_REQUIRED');
  const url=this.origin+'/api/v3-bridge/jobs/'+siteJobId+'/'+operation;
  let response;try{response=await this.fetchImpl(url,{method,headers:{Authorization:'Bearer '+this.token,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(input)}:{}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(this.timeoutMs)});}catch{fail('V3_RELAY_OUTCOME_UNKNOWN');}
  if(!(response instanceof Response)||response.redirected||response.url!==url||!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type')||''))fail('V3_RELAY_RESPONSE_INVALID');
  let body;try{const text=await response.text();if(text.length>32768)fail('V3_RELAY_RESPONSE_TOO_LARGE');body=JSON.parse(text);}catch(error){if(error.message==='V3_RELAY_RESPONSE_TOO_LARGE')throw error;fail('V3_RELAY_OUTCOME_UNKNOWN');}
  if(!response.ok)fail(typeof body?.error==='string'&&/^[A-Z0-9_]{3,80}$/.test(body.error)?body.error:'V3_RELAY_REJECTED');
  if(body?.site_job_id!==siteJobId||!sha(body.local_snapshot_hash)||!sha(body.site_snapshot_hash)||method==='POST'&&(body.local_snapshot_hash!==input.local_snapshot_hash||body.site_snapshot_hash!==input.site_snapshot_hash))fail('V3_RELAY_READBACK_MISMATCH');
  return body;
 }
 status(id){return this.call(id,'status');}
 capability(id){return this.call(id,'capability');}
 dispatch(id,input){return this.call(id,'dispatch',input);}
 reconcile(id,input){return this.call(id,'reconcile',input);}
}
