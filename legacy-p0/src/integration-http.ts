import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {relative,isAbsolute} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Db} from './database.ts';
import type {WebServerOptions} from './web-server.ts';
import {TaskService} from './task-service.ts';
import {PublisherStore} from './publisher-store.ts';
import {renderDashboard} from './web-ui.ts';

// All integrated requests terminate here. Never fall through to the standalone,
// globally scoped routes, account inventory, synchronization or execution worker.
export async function integratedRequest(req:IncomingMessage,res:ServerResponse,db:Db,options:WebServerOptions) {
 const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
 const bridge=options.integration!;
 try {
  const context=bridge.context(req),url=new URL(req.url||'/','http://localhost');
  const tasks=new TaskService(db,{roots:[context.contentRoot],ledgerPath:options.ledgerPath,stagingRoot:options.stagingRoot!,statusBatchAllowed:id=>bridge.batchAllowed(context,id)}),store=new PublisherStore(db);
  const allowed=(path:string)=>{const rel=relative(realpathSync(context.contentRoot),realpathSync(path));return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');};
  const batchAllowed=(id:string)=>bridge.batchAllowed(context,id);
  const jobMatch=url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/|$)/);
  const batchMatch=url.pathname.match(/^\/api\/batches\/([^/]+)(?:\/|$)/);
  if(jobMatch){let job;try{job=store.getJob(decodeURIComponent(jobMatch[1]));}catch{return send(404,{error:'NOT_FOUND'});}if(!batchAllowed(String(job.batch_id)))return send(404,{error:'NOT_FOUND'});}
  if(batchMatch&&!batchAllowed(decodeURIComponent(batchMatch[1])))return send(404,{error:'NOT_FOUND'});
  if(req.method==='GET'&&url.pathname==='/') {
   const nonce=context.nonce||randomUUID();
   const settings=JSON.stringify({prefix:'/publisher',workspace:context.id,accountId:context.operatorAccountId}).replaceAll('<','\\u003c');
   const bootstrap=`const integrationSettings=${settings};const originalFetch=window.fetch.bind(window);window.fetch=async(input,init={})=>{const u=new URL(input,location.href);if(u.origin!==location.origin)throw Error('INTEGRATION_ORIGIN_REQUIRED');if(u.pathname.startsWith('/api/'))u.pathname=integrationSettings.prefix+u.pathname;u.searchParams.set('workspace',integrationSettings.workspace);u.searchParams.set('accountId',integrationSettings.accountId);const h=new Headers(init.headers);if(init.method&&init.method!=='GET'&&init.method!=='HEAD'){const r=await originalFetch('/api/state?workspace='+encodeURIComponent(integrationSettings.workspace));if(!r.ok)throw Error('SESSION_REQUIRED');h.set('x-local-token',(await r.json()).token);}return originalFetch(u,{...init,headers:h});};`;
   const page=renderDashboard().replaceAll('<style>',`<style nonce="${nonce}">`).replaceAll('<script>',`<script nonce="${nonce}">`).replace('</head>',`<script nonce="${nonce}">${bootstrap}</script></head>`);
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','x-frame-options':'SAMEORIGIN','content-security-policy':`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`});return res.end(page);
  }
  if(req.method==='GET'&&url.pathname==='/api/batches')return send(200,{batches:tasks.listBatches().filter(b=>batchAllowed(String(b.batch_id)))});
  if(req.method==='GET'&&url.pathname==='/api/jobs')return send(200,{jobs:store.listJobs(200,{batchIds:bridge.batchIds(context).filter(batchAllowed)})});
  if(req.method==='GET'&&jobMatch&&url.pathname===`/api/jobs/${jobMatch[1]}`){const id=decodeURIComponent(jobMatch[1]);return send(200,{job:store.getJob(id),history:store.jobHistory(id),formSnapshot:store.latestFormSnapshot(id)});}
  if(req.method==='GET'&&url.pathname==='/api/content/candidates'){
   const platforms=context.platforms as any;const result=tasks.candidates(platforms,url.searchParams.get('includePublished')==='1',url.searchParams.get('includeIncomplete')==='1');
   if(result.status==='CANDIDATES')result.candidates=result.candidates.filter(item=>allowed(item.packageRoot));return send(200,result);
  }
  if(req.method==='POST'&&url.pathname==='/api/history/clear')return send(200,tasks.clearHistory());
  if(req.method==='POST'&&url.pathname==='/api/history/restore'){tasks.restoreHistory();return send(200,{restored:true});}
  if(req.method==='POST'&&url.pathname==='/api/tasks/execute') {
   if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(400,{error:'application/json required'});
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)return send(413,{error:'request too large'});}const input=JSON.parse(raw||'{}');
   if(input.facebookAccountId&&input.facebookAccountId!==context.publisherAccountId)return send(409,{error:'Facebook 账号与当前归属不一致'});
   if(input.workspace&&input.workspace!==context.id)return send(409,{error:'客户归属不一致'});
   if(!Array.isArray(input.platforms)||!input.platforms.length||input.platforms.some((p:string)=>!context.platforms.includes(p)))return send(409,{error:'平台不属于当前绑定'});
   const article=String(input.selectedArticleId||input.value||'');
   // Do not adopt or change any unowned history, including an UNKNOWN attempt.
   const prior=db.prepare('SELECT batch_id,state FROM jobs WHERE article_id=?').all(article);
   if(prior.some(j=>!batchAllowed(String(j.batch_id))))return send(400,{error:'历史任务未确认归属，禁止自动采用或重新发布'});
   if(prior.some(j=>['UNKNOWN','SUBMITTED_PENDING_CONFIRMATION','RECONCILE_PENDING'].includes(String(j.state))))return send(409,{error:'历史任务结果待核对，禁止创建替代任务或重发'});
   const packages=tasks.library.index().filter(p=>allowed(p.packageRoot));
   const selected=packages.find(p=>p.articleId===article&&p.packageRoot===input.selectedPackageRoot&&p.version===input.selectedVersion);
   if(!selected)return send(409,{error:'请明确选择当前客户的完整内容版本'});
   const result=tasks.execute({...input,facebookAccountId:context.publisherAccountId},packages);
   if(result.batch_id)bridge.register(context,String(result.batch_id));
   return send(result.batch_id?201:409,result);
  }
  if(req.method==='POST'&&batchMatch&&url.pathname.endsWith('/stop'))return send(200,tasks.stopBatch(decodeURIComponent(batchMatch[1])));
  // Execution and platform-wide inventory are deliberately unavailable until a
  // scoped worker/readback adapter exists. No retry or inferred ownership.
  return send(req.method==='GET'?404:409,{error:'INTEGRATED_LEGACY_OPERATION_UNAVAILABLE'});
 }catch(error){return send(400,{error:String(error)});}
}
