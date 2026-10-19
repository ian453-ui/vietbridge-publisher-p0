import {createHash,randomUUID} from 'node:crypto';
const phases=new Map([['/api/state','state'],['/api/facebook','facebook'],['/api/group-library','library']]);
/** Bounded metadata only: never headers, cookies, query strings, bodies or errors. */
export function observeReadTiming(req,res,url,{emit=row=>console.info('publisher_read '+JSON.stringify(row)),now=()=>performance.now(),date=()=>new Date().toISOString()}={}){
 const phase=req.method==='GET'&&phases.get(url.pathname);if(!phase||typeof res.once!=='function')return;
 const workspace=url.searchParams.get('workspace'),request_id=randomUUID(),workspace_hash=/^ws-[a-z0-9-]{1,80}$/i.test(workspace||'')?createHash('sha256').update(workspace).digest('hex').slice(0,12):null,start=now();let ended=false;
 const send=row=>{try{emit(row);}catch{/* Observation cannot change authentication or request behavior. */}};
 send({event:'start',phase,request_id,workspace_hash,utc:date()});
 const finish=outcome=>{if(ended)return;ended=true;send({event:'end',phase,request_id,workspace_hash,utc:date(),outcome,status:res.statusCode,elapsed_ms:Math.max(0,Math.round(now()-start))});};
 try{res.once('finish',()=>finish('finished'));res.once('close',()=>finish(res.writableFinished?'finished':'closed'));}catch{ended=true;}
}
