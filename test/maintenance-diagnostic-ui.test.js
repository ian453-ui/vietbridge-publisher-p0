import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const client=await import(process.env.DIAGNOSTIC_UI_MODULE?pathToFileURL(process.env.DIAGNOSTIC_UI_MODULE):new URL('../src/unified-client.js',import.meta.url));
const scope={job_id:'job-009',content_id:'content-009',workspace:'ws-fixture',account_id:'fixture-account',operator_actor_id:'61594159443807',target_page_id:'1459220443931651',platform:'facebook',transport:'BROWSER',snapshot_hash:'a'.repeat(64),media_count:1};
const original={id:scope.job_id,content_id:scope.content_id,workspace:scope.workspace,account_id:scope.account_id,snapshot_hash:scope.snapshot_hash,state:'UNKNOWN',attempt_id:'retained-attempt',snapshot:{operatorActorId:scope.operator_actor_id,targetPageId:scope.target_page_id,platform:'facebook',transport:'BROWSER',body:'Complete approved fixture',media:['fixture.png'],externalId:scope.operator_actor_id,expectedIdentity:'LP fixture'},evidence:{},execution:{canExecute:false,mode:'DISABLED'},readOnlyDiagnostic:{canStart:true,operation:'FACEBOOK_READ_ONLY_DIAGNOSTIC',scope}};

test('maintenance diagnostic display rejects missing capability, wrong account, every changed scope and non-UNKNOWN platform state',()=>{
 assert.equal(client.maintenanceDiagnosticCanStart(original,scope.account_id),true);
 for(const patch of [{readOnlyDiagnostic:undefined},{account_id:'another-account'},{state:'READY'},{snapshot:{...original.snapshot,platform:'wechat_channels'}},{snapshot:{...original.snapshot,transport:'API'}}])assert.equal(client.maintenanceDiagnosticCanStart({...original,...patch},scope.account_id),false);
 for(const key of Object.keys(scope))assert.equal(client.maintenanceDiagnosticCanStart({...original,readOnlyDiagnostic:{...original.readOnlyDiagnostic,scope:{...scope,[key]:'changed'}}},scope.account_id),false);
 assert.equal(client.maintenanceDiagnosticCanStart({...original,readOnlyDiagnostic:{...original.readOnlyDiagnostic,scope:{...scope,execute:true}}},scope.account_id),false);
});

function node(value=''){return {value,dataset:{},disabled:false,isConnected:true,options:[],textContent:'',innerHTML:'',addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}};}
async function mounted(t,job){
 const elements=new Map(),buttons=[];const account={id:scope.account_id,platform:'facebook',identity_type:'PAGE',display_name:'LP fixture',enabled:1};
 const jobs=node();Object.defineProperty(jobs,'innerHTML',{get(){return this.html;},set(value){this.html=value;buttons.length=0;for(const match of value.matchAll(/<button\b([^>]*)>/g)){const b=node();b.disabled=/\bdisabled\b/.test(match[1]);for(const attribute of match[1].matchAll(/data-([\w-]+)="([^"]*)"/g))b.dataset[attribute[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=attribute[2];buttons.push(b);}}});
 jobs.querySelectorAll=selector=>buttons.filter(b=>selector.split(',').some(part=>{const key=part.match(/^\[data-([\w-]+)\]$/)?.[1]?.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());return key&&Object.hasOwn(b.dataset,key);}));
 const root=node();root.dataset={workspace:scope.workspace,account:scope.account_id,platform:'facebook'};
 root.querySelector=selector=>{if(selector==='#unified-jobs')return jobs;if(!elements.has(selector))elements.set(selector,node());return elements.get(selector);};root.querySelectorAll=selector=>selector.startsWith('#')?selector.split(',').map(s=>root.querySelector(s)):[];
 root.querySelector('#unified-target-account').value=account.id;root.querySelector('#unified-platform').value='facebook';root.querySelector('#unified-all-accounts').checked=false;
 const ws=node(scope.workspace),operating=node(account.id),requests=[],priorDocument=globalThis.document,priorFetch=globalThis.fetch;
 globalThis.document={getElementById:id=>id==='unified-publisher'?root:id==='ws'?ws:id==='operating-account'?operating:null};
 globalThis.fetch=async(path,options={})=>{requests.push({path,method:options.method||'GET',body:options.body});const body=path.endsWith('/diagnostics')?{state:'DONE',jobId:job.id,scope,result:{conclusion:'INCOMPLETE',absenceProven:false}}:path.includes('/content-status')?{states:{}}:{jobs:[job]};return {ok:true,headers:{get:()=> 'read-only'},json:async()=>body};};
 t.after(()=>{globalThis.document=priorDocument;globalThis.fetch=priorFetch;});
 await client.mountUnifiedPublisher({workspace:scope.workspace,account,token:'mock-csrf',accounts:[account],contents:[],maintenanceMode:'read-only',onChanged:async()=>{}});
 return {buttons,requests,root};
}

test('rendered maintenance entry enables only the configured diagnostic, makes no automatic POST, and explicit click cannot submit or reconcile',async t=>{
 const m=await mounted(t,original),diagnostic=m.buttons.find(b=>b.dataset.diagnose===original.id);assert.equal(diagnostic.disabled,false);
 for(const b of m.buttons.filter(b=>Object.keys(b.dataset).some(k=>['reconcile','retry','finish','manualComplete','observeComposer','cancel','reopen','resolvePreparation'].includes(k))))assert.equal(b.disabled,true);
 assert.equal(m.requests.filter(r=>r.method==='POST').length,0);await diagnostic.onclick();const posts=m.requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/unified/workspaces/'+scope.workspace+'/jobs/'+scope.job_id+'/diagnostics');assert.deepEqual(JSON.parse(posts[0].body),{snapshot_hash:scope.snapshot_hash});assert.equal(diagnostic.disabled,true);assert.ok(m.requests.every(r=>!r.path.endsWith('/execute')&&!r.path.endsWith('/reconcile')));
});

test('rendered empty-config maintenance entry keeps diagnostic and all history actions disabled',async t=>{
 const m=await mounted(t,{...original,readOnlyDiagnostic:undefined}),diagnostic=m.buttons.find(b=>b.dataset.diagnose===original.id);assert.equal(diagnostic.disabled,true);assert.equal(m.requests.filter(r=>r.method==='POST').length,0);
});
