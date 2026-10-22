/** One explicit read attempt. Injected code must itself be an authorized read-only adapter. */
export async function collectMetricOnce(store,targetId,shape,{workspace,accountId,adapter,timeoutMs=5000,now=()=>Date.now()}={}){
 if(!adapter||adapter.readOnly!==true||typeof adapter.read!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('METRIC_COLLECTOR_INVALID');
 const attempt=store.beginCollection(targetId,shape,{workspace,accountId,now:now()}),controller=new AbortController();let timer;
 try{
  const packet=await Promise.race([Promise.resolve().then(()=>adapter.read({target:structuredClone(attempt.target),selector:structuredClone(shape),signal:controller.signal,maxEvidenceBytes:5*1024*1024})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('COLLECTOR_TIMEOUT'));},timeoutMs);})]);
  try{return store.ingest(targetId,packet,{workspace,accountId,now:now(),attemptId:attempt.id});}
  catch{return store.failCollection(attempt.id,{workspace,accountId,now:now(),reason:'COLLECTOR_INVALID_RESULT'});}
 }catch(error){return store.failCollection(attempt.id,{workspace,accountId,now:now(),reason:error.message==='COLLECTOR_TIMEOUT'?'COLLECTOR_TIMEOUT':'COLLECTOR_FAILED'});}
 finally{clearTimeout(timer);controller.abort();}
}
