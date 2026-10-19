import {executionScope} from './single-execution-permit.js';
/** Authenticated parent server calls this only after Host/auth/Origin/CSRF validation. */
export function unifiedRoute(publisher, method, url, input={},executor=null,principal=null) {
  const reopen=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/browser-reopen$/);
  if(reopen){if(!executor?.browserReopen)throw Error('BROWSER_REOPEN_UNAVAILABLE');const ws=decodeURIComponent(reopen[1]),id=decodeURIComponent(reopen[2]);if(method==='GET')return {status:200,body:executor.browserReopen.view(ws,id)};if(method==='POST')return executor.browserReopen.start(ws,id,input).then(body=>({status:200,body}));return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};}
  const notPublished=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/finish-unpublished$/);
  if(notPublished){
    if(method!=='POST')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};
    if(!executor)throw Error('执行器未接入');
    return {status:200,body:executor.resolveNotPublished(decodeURIComponent(notPublished[1]),decodeURIComponent(notPublished[2]),input)};
  }
  const operatorAction=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/(finish|manual-complete)$/);
  if(operatorAction){
    if(method!=='POST')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};
    const workspace=decodeURIComponent(operatorAction[1]),id=decodeURIComponent(operatorAction[2]);
    return {status:200,body:operatorAction[3]==='finish'?publisher.finish(workspace,id):publisher.manualComplete(workspace,id,input)};
  }
  const observation=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/composer-observation$/);
  if(observation){if(!executor?.composerObservations)throw Error('COMPOSER_OBSERVATION_UNAVAILABLE');const ws=decodeURIComponent(observation[1]),id=decodeURIComponent(observation[2]);if(method==='GET')return {status:200,body:executor.composerObservations.view(ws,id)};if(method==='POST')return {status:202,body:executor.composerObservations.start(ws,id,input)};return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};}
  const diagnostic=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/diagnostics$/);
  if(diagnostic){if(!executor?.diagnostics)throw Error('只读诊断未接入');const ws=decodeURIComponent(diagnostic[1]),id=decodeURIComponent(diagnostic[2]);if(method==='GET')return {status:200,body:executor.diagnostics.view(ws,id)};if(method==='POST')return {status:202,body:executor.diagnostics.start(ws,id,input)};return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};}
  const capability=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/execution-capability$/);
  if(capability){if(method!=='GET')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};if(!executor)throw Error('执行器未接入');const workspace=decodeURIComponent(capability[1]),id=decodeURIComponent(capability[2]),job=publisher.job(workspace,id);return {status:200,body:{...executor.executionCapability(workspace,id),scope:executionScope(job),state:job.state,attemptId:job.attempt_id}};}
  const contentStatus=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/accounts\/([^/]+)\/content-status$/);
  if(contentStatus){if(method!=='GET')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};return {status:200,body:publisher.contentStatus(decodeURIComponent(contentStatus[1]),decodeURIComponent(contentStatus[2]))};}
  const preparation=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/resolve-preparation$/);
  if(preparation){if(method!=='POST')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};if(!executor)throw Error('执行器未接入');return executor.resolvePreparation(decodeURIComponent(preparation[1]),decodeURIComponent(preparation[2]),input).then(body=>({status:200,body}));}
  const resumePrepared=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/resume-prepared$/);
  if(resumePrepared){if(method!=='POST')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};if(!executor)throw Error('执行器未接入');return executor.resumePrepared(decodeURIComponent(resumePrepared[1]),decodeURIComponent(resumePrepared[2]),input).then(body=>({status:200,body}));}
  const inspect=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/accounts\/([^/]+)\/inspect$/);
  if(inspect){if(method!=='POST')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};if(!executor)throw Error('执行器未接入');return executor.inspectAccount(decodeURIComponent(inspect[1]),decodeURIComponent(inspect[2])).then(body=>({status:200,body}));}
  const accounts=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/accounts(?:\/(select))?$/);
  if(accounts){const workspace=decodeURIComponent(accounts[1]);if(method==='GET'&&!accounts[2])return {status:200,body:publisher.accountsView(workspace)};if(method==='POST')return {status:accounts[2]?200:201,body:accounts[2]?publisher.selectAccount(workspace,input.id):publisher.saveAccount(workspace,input)};return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};}
  const execute=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/jobs\/([^/]+)\/(execute|reconcile|reopen)$/);
  if(execute){if(method!=='POST')return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};if(!executor)throw Error('执行器未接入');return Promise.resolve(executor[execute[3]](decodeURIComponent(execute[1]),decodeURIComponent(execute[2]),input)).then(body=>({status:200,body}));}
  const transport=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/accounts\/([^/]+)\/transport$/);
  if(transport)return method==='POST'?{status:200,body:publisher.switchTransport(decodeURIComponent(transport[1]),decodeURIComponent(transport[2]),input.transport,input.config_url)}:{status:405,body:{error:'METHOD_NOT_ALLOWED'}};
  const route=url.pathname.match(/^\/api\/unified\/workspaces\/([^/]+)\/(content|jobs)(?:\/([^/]+)\/(approve|cancel))?$/);
  if(!route)return null;
  const workspace=decodeURIComponent(route[1]),kind=route[2],id=route[3]&&decodeURIComponent(route[3]),action=route[4];
  if(method==='GET' && kind==='jobs' && !id) {
    const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100;
    const offset=url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0;
    return {status:200,body:{jobs:publisher.list(workspace,url.searchParams.get('accountId')||null,{limit,offset}).map(job=>{const execution=executor?.executionCapability(workspace,job.id)||{canExecute:false,mode:'DISABLED'};return {...job,canExecute:execution.canExecute,execution,canResumePrepared:executor?.canResumePrepared?.(job)===true,...(executor?.diagnostics?.maintenanceScope?{readOnlyDiagnostic:executor.diagnostics.maintenanceCapability(workspace,job.id,principal)}:{}),...(executor?.browserReopen?{browserReopen:executor.browserReopen.view(workspace,job.id)}:{})};})}};
  }
  if(method==='POST' && kind==='content' && !id)return {status:201,body:publisher.importContent(workspace,input)};
  if(method==='POST' && kind==='jobs' && !id)return {status:201,body:publisher.createPageJob(workspace,input)};
  if(method==='POST' && kind==='jobs' && id && action==='approve')return {status:200,body:(executor||publisher).approve(workspace,id,input.snapshot_hash)};
  if(method==='POST' && kind==='jobs' && id && action==='cancel')return {status:200,body:publisher.cancel(workspace,id)};
  return {status:405,body:{error:'METHOD_NOT_ALLOWED'}};
}
