import {readFileSync,existsSync,realpathSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {isAbsolute,resolve,dirname} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {integrationContext} from './publisher-core/integration-context.ts';
import {BrowserResources} from './browser-resources.js';
export const scopeFingerprint=c=>createHash('sha256').update(JSON.stringify([c.id,c.operatorAccountId,c.publisherAccountId,c.contentRoot,[...c.platforms].sort()])).digest('hex');

// Configuration/provenance only. No credentials and no copied V1/V2 records.
export class PublisherIntegration {
  constructor(store,options){
    if(!isAbsolute(options.dbPath)||!isAbsolute(options.scopeFile))throw Error('发布数据库和归属文件必须使用绝对路径');
    if(!existsSync(options.dbPath))throw Error('发布数据库不存在；禁止在错误路径初始化空数据库');
    if(realpathSync(options.dbPath)===realpathSync(store.dbPath||options.operatorDbPath))throw Error('V1 与 V2 数据库必须分离');
    this.store=store;this.options=options;
    this.bindings=new Map();
    for(const b of options.bindings||[]){
      const key=JSON.stringify([b.workspace,b.accountId]);
      if(this.bindings.has(key)||!b.publisherAccountId||!isAbsolute(b.contentRoot)||!Array.isArray(b.platforms)||!b.platforms.length)throw Error('发布映射不完整或重复');
      if(b.workspace!=='ws-vietbridge'&&b.platforms.some(p=>p!=='facebook'))throw Error('其他客户尚未绑定独立的非 Facebook 平台账号');
      this.bindings.set(key,Object.freeze({...b,contentRoot:realpathSync(b.contentRoot),platforms:Object.freeze([...b.platforms])}));
    }
    this.scopes=existsSync(options.scopeFile)?JSON.parse(readFileSync(options.scopeFile,'utf8')):[];
    if(!Array.isArray(this.scopes)||this.scopes.some(s=>!s.batchId||!s.workspace||!s.accountId||!s.publisherAccountId||!s.sourceRef||!/^[a-f0-9]{64}$/.test(s.fingerprint||''))||new Set(this.scopes.map(s=>s.batchId)).size!==this.scopes.length)throw Error('发布归属文件无效');
    this.scopeIndex=new Map(this.scopes.map(s=>[s.batchId,Object.freeze({...s})]));
    this.resources=new BrowserResources(options.resourceDir||options.scopeFile+'.browser-locks');
    const browserResources={acquire:(port,owner,pending,reconcile=false)=>{
      const profile=store.db.prepare('SELECT user_data_dir FROM execution_profiles WHERE cdp_port=?').get(port);
      if(!profile)throw Error('V1 浏览器端口尚未登记到 V2 执行配置，禁止绕过共享锁');
      return this.resources.acquire(profile.user_data_dir,owner,pending,{reconcile});
    }};
    this.ready=(options.createPublisherServer?Promise.resolve({createPublisherServer:options.createPublisherServer}):import('../../Publisher-P0/src/web-server.ts')).then(({createPublisherServer})=>{
    this.server=createPublisherServer({...options,contentRoots:options.contentRoots||[...new Set([...this.bindings.values()].map(b=>b.contentRoot))],browserResources,workerEnabled:options.workerEnabled===true,driveSyncEnabled:options.driveSyncEnabled===true,integration:{
      context:req=>{if(!req[integrationContext])throw Error('内部客户上下文缺失');return req[integrationContext];},
      batchAllowed:(context,id)=>this.batchAllowed(context,id),batchIds:context=>this.scopes.filter(s=>this.batchAllowed(context,s.batchId)).map(s=>s.batchId),register:(context,id)=>this.register(context,id)
    }});
    this.handler=this.server.listeners('request')[0];
    });
    this.ready.catch(()=>{});
  }
  context(workspace,accountId){
    const workspaceRow=this.store.view(workspace).workspaces.find(w=>w.id===workspace);
    const account=this.store.account(workspace,accountId);
    const binding=this.bindings.get(JSON.stringify([workspace,accountId]));
    if(!workspaceRow||!account.enabled||!binding)throw Error('当前客户与账号尚未配置发布映射');
    if(workspaceRow.content_root&&realpathSync(workspaceRow.content_root)!==binding.contentRoot)throw Error('客户内容库与发布映射不一致');
    return Object.freeze({id:workspace,name:workspaceRow.name,operatorAccountId:accountId,publisherAccountId:binding.publisherAccountId,contentRoot:binding.contentRoot,platforms:binding.platforms});
  }
  batchAllowed(c,id){const s=this.scopeIndex.get(id);return Boolean(s&&s.workspace===c.id&&s.accountId===c.operatorAccountId&&s.publisherAccountId===c.publisherAccountId&&s.fingerprint===scopeFingerprint(c));}
  register(c,id){
    const old=this.scopeIndex.get(id);if(old){if(!this.batchAllowed(c,id))throw Error('历史任务归属不一致，禁止转移');return;}
    const next=[...this.scopes,{batchId:id,workspace:c.id,accountId:c.operatorAccountId,publisherAccountId:c.publisherAccountId,fingerprint:scopeFingerprint(c),sourceRef:'unified-task-creation'}];
    const temp=this.options.scopeFile+'.tmp';
    writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});
    const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,this.options.scopeFile);
    const dir=openSync(dirname(this.options.scopeFile),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
    this.scopes=next;this.scopeIndex.set(id,Object.freeze({...next.at(-1)}));
  }
  async dispatch(req,res,c){await this.ready;req[integrationContext]=c;return this.handler(req,res);}
  async fetch(c,url,init={}){
    const req=Readable.from(init.body?[Buffer.from(init.body)]:[]);
    Object.assign(req,{method:init.method||'GET',url:new URL(url).pathname+new URL(url).search,headers:init.headers||{}});
    let status=500;const chunks=[];
    const res={setHeader(){},writeHead(s){status=s;},end(value){if(value)chunks.push(Buffer.from(value));}};
    await this.dispatch(req,res,c);
    return {ok:status>=200&&status<300,status,json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))};
  }
  close(){void this.ready.then(()=>this.server.emit('close')).catch(()=>{});}
}

export function integrationOptions(env=process.env){
  if(!env.PUBLISHER_INTEGRATION_CONFIG)return null;
  const options=JSON.parse(readFileSync(env.PUBLISHER_INTEGRATION_CONFIG,'utf8'));
  // Side effects remain off during acceptance; enabling existing workers is a Mac release action.
  return {...options,workerEnabled:options.workerEnabled===true&&env.PUBLISHER_ENABLE_EXECUTION==='1',driveSyncEnabled:false};
}

export function validateIntegrationPaths(operatorDbPath,options){
  if(!isAbsolute(operatorDbPath)||!isAbsolute(options.dbPath)||!existsSync(operatorDbPath)||!existsSync(options.dbPath))throw Error('整合必须显式使用现有两个独立数据库的绝对路径');
  if(realpathSync(operatorDbPath)===realpathSync(options.dbPath))throw Error('V1 与 V2 数据库必须分离');
}
