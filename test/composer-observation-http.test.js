import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createApp} from '../src/server.js';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {BrowserResources} from '../src/browser-resources.js';
import {executionScope} from '../src/single-execution-permit.js';
test('formal observation endpoint requires admin/CSRF/full scope and cannot write seven-table history or release original lease',async()=>{
 const root=mkdtempSync(join(tmpdir(),'composer-http-')),path=join(root,'publisher-unified.sqlite'),store=new Store(path,{seedDemo:false}),publisher=new UnifiedPublisher(store);
 const ws=store.saveWorkspace({name:'QA'}),profile=store.saveProfile(ws.id,{name:'QA',cdp_port:59995,user_data_dir:join(root,'profile')});mkdirSync(profile.user_data_dir);
 const account=publisher.saveAccount(ws.id,{profile_id:profile.id,display_name:'QA',expected_identity:'QA',identity_type:'PAGE',external_id:'123456',operator_actor_id:'123456',target_page_id:'654321'}),content=publisher.importContent(ws.id,{source_id:'QA',revision:'1',body:'frozen',media:[]}),job=publisher.createPageJob(ws.id,{account_id:account.id,content_id:content.id});store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(job.id);
 const history=()=>JSON.stringify(['publisher_jobs','publisher_execution_permits','publisher_execution_permit_events','publisher_prepare_intents','publisher_submit_intents','publisher_submit_receipts','publisher_job_assets'].map(table=>store.db.prepare(`SELECT * FROM ${table}`).all()));
 const resources=new BrowserResources(join(root,'browser-resource-locks')),release=resources.acquire(profile.user_data_dir,'operator:'+profile.id,()=>true);release();const lease=join(resources.directory,createHash('sha256').update(realpathSync(profile.user_data_dir)).digest('hex'),'owner.json'),bytes=readFileSync(lease,'utf8');let calls=0;
 const cloud={mode:'mac-tunnel',executionConnected:true,host:'publisher.vietbridge.one',origin:'https://publisher.vietbridge.one',user:'fixture',password:'disposable-test-password',dataDir:root,accessFile:join(root,'access.json')};
 const server=createApp(path,{unified:true,cloud,resources,executionEnabled:false,library:{roots:[root],gptInboxBase:null},drivers:{create:async()=>({observeComposer:async()=>{calls++;return {kind:'COMPOSER_OBSERVATION',conclusion:'INCOMPLETE',absenceProven:false,activeActorVerified:false,samples:[]};},closeDiagnostic:async()=>{},submit(){throw Error('forbidden');}})}});
 const before=history(),auth={authorization:'Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64')};
 async function call(url,body,headers={}){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url,method:body===undefined?'GET':'POST',headers:{host:cloud.host,...headers}});let status=200,text='';const res={setHeader(){},writeHead(n){status=n;},end(s=''){text+=s;}};await server.listeners('request')[0](req,res);return {status,data:JSON.parse(text)};}
 const url=`/api/unified/workspaces/${ws.id}/jobs/${job.id}/composer-observation`,input={...executionScope(job),profile_id:profile.id};
 try{
  assert.equal((await call(url)).status,401);assert.equal((await call(url,input)).status,401);const state=(await call('/api/state',undefined,auth)).data,headers={...auth,origin:cloud.origin,'content-type':'application/json','x-local-token':state.token};
  assert.equal((await call(url,input,auth)).status,409);assert.equal((await call(url,input,{...headers,origin:'https://evil.example'})).status,409);
  assert.equal((await call(url,{...input,operator_actor_id:'999'},headers)).status,409);assert.equal(calls,0);
  const token=(await call('/api/access/tokens',{name:'QA read app',password:cloud.password,workspaces:[ws.id],scopes:['jobs:read'],days:1},headers)).data.token;assert.equal((await call(url,undefined,{authorization:'Bearer '+token})).status,403);assert.equal((await call(url,input,{authorization:'Bearer '+token,'content-type':'application/json'})).status,403);
  assert.equal((await call(url,input,headers)).status,202);for(let i=0;i<20;i++){if((await call(url,undefined,auth)).data.state==='DONE')break;await new Promise(r=>setTimeout(r,2));}
  assert.equal((await call(url,undefined,auth)).data.state,'DONE');assert.equal(calls,1);assert.equal(history(),before);assert.equal(readFileSync(lease,'utf8'),bytes);await call(url,input,headers);assert.equal(calls,1);
 }finally{await new Promise(resolve=>{server.once('storage-closed',resolve);server.emit('close');});store.close();rmSync(root,{recursive:true,force:true});}
});
