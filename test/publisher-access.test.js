import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {PublisherAccess,passwordRecord} from '../src/publisher-access.js';
import {createApp} from '../src/server.js';
const password='disposable-test-password-at-least-24';
test('six-character passwords are accepted and shorter passwords are rejected',()=>{assert.doesNotThrow(()=>passwordRecord('123456'));assert.throws(()=>passwordRecord('12345'),/6至512/);});
test('login and application settings are reachable before selecting a customer',()=>{const client=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');assert.match(client,/\['access','v1','customers','verification'\]\.includes\(route\)/);assert.match(client,/route==='access'\?'登录与应用'/);});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'vb-access-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const config={mode:'mac-tunnel',executionConnected:true,origin:'https://publisher.vietbridge.one',host:'publisher.vietbridge.one',user:'admin',password,dataDir:root,accessFile:join(root,'publisher-access.json')};return {root,config,access:new PublisherAccess(config)};}
test('browser sessions expire; password rotation invalidates sessions and old Basic credentials and persists only hashes',t=>{const f=fixture(t);let now=1;f.access.now=()=>now;const session=f.access.login('admin',password),request={headers:{cookie:'publisher_session='+session}};assert.equal(f.access.authenticate(request).type,'admin');now+=7*24*3600000;assert.equal(f.access.authenticate(request),null);const current=f.access.login('admin',password);f.access.changePassword(password,password+'-new');assert.equal(f.access.authenticate({headers:{cookie:'publisher_session='+current}}),null);assert.equal(f.access.authenticate({headers:{authorization:'Basic '+Buffer.from('admin:'+password).toString('base64')}}),null);const raw=readFileSync(f.config.accessFile,'utf8');assert.ok(!raw.includes(password));assert.equal(statSync(f.config.accessFile).mode&0o077,0);assert.ok(new PublisherAccess({...f.config,password:''}).validPassword('admin',password+'-new'));});
test('application credentials are one-time plaintext, customer scoped, expiring and revocable, never admin or social execution',t=>{const f=fixture(t);const result=f.access.createToken({name:'Third party',password,days:1,workspaces:['ws-a'],scopes:['jobs:read','content:import','jobs:create']});const req={headers:{authorization:'Bearer '+result.token}},principal=f.access.authenticate(req);assert.ok(principal);for(const path of ['/api/access/tokens','/api/state','/api/unified/workspaces/ws-b/jobs','/api/unified/workspaces/ws-a/jobs/x/execute','/api/unified/workspaces/ws-a/jobs/x/approve'])assert.equal(f.access.authorizeApp(principal,'GET',new URL(path,f.config.origin)),false);assert.equal(f.access.authorizeApp(principal,'GET',new URL('/api/unified/workspaces/ws-a/jobs',f.config.origin)),true);assert.ok(!JSON.stringify(f.access.list()).includes(result.token));assert.ok(!readFileSync(f.config.accessFile,'utf8').includes(result.token));f.access.revoke(result.record.id);assert.equal(f.access.authenticate(req),null);const reopened=new PublisherAccess(f.config);assert.equal(reopened.authenticate(req),null);});
test('V3 relay scopes require exact Site and task IDs; old tokens cannot gain execution access',t=>{
 const f=fixture(t),siteJob='e11a0a0b-36d1-4b96-a547-650324836d48',base='/api/v3-bridge/jobs/'+siteJob;
 const old=f.access.createToken({name:'old',password,days:1,workspaces:['ws-a'],scopes:['jobs:read']}),oldPrincipal=f.access.authenticate({headers:{authorization:'Bearer '+old.token}});
 assert.equal(f.access.authorizeApp(oldPrincipal,'POST',new URL(base+'/dispatch',f.config.origin)),false);
 assert.throws(()=>f.access.createToken({name:'unsafe',password,days:1,workspaces:['ws-a'],scopes:['v3:dispatch']}),/V3 应用令牌/);
 const created=f.access.createToken({name:'specific',password,days:1,workspaces:['ws-a'],scopes:['v3:status','v3:upload','v3:dispatch'],site_project_id:'appgprj_6ad97a034fd08191a8399eeda10f048c',site_job_ids:[siteJob]});
 const principal=f.access.authenticate({headers:{authorization:'Bearer '+created.token}});
 assert.equal(f.access.authorizeApp(principal,'GET',new URL(base+'/status',f.config.origin)),true);
 assert.equal(f.access.authorizeApp(principal,'POST',new URL(base+'/dispatch',f.config.origin)),true);
 assert.equal(f.access.authorizeApp(principal,'POST',new URL(base+'/media/0',f.config.origin)),true);
 assert.equal(f.access.authorizeApp(principal,'POST',new URL('/api/v3-bridge/jobs/39786221-4438-4b94-8651-ff31f6049113/media/0',f.config.origin)),false);
 assert.equal(f.access.authorizeApp(principal,'POST',new URL(base+'/reconcile',f.config.origin)),false);
 assert.equal(f.access.authorizeApp(principal,'POST',new URL('/api/v3-bridge/jobs/39786221-4438-4b94-8651-ff31f6049113/dispatch',f.config.origin)),false);
 assert.equal(f.access.authorizeApp(principal,'POST',new URL('/api/unified/workspaces/ws-a/jobs/'+siteJob+'/execute',f.config.origin)),false);
});
test('authenticated Mac HTTP relay is dormant by default and rejects unbound jobs when enabled',async t=>{
 const f=fixture(t),job='e11a0a0b-36d1-4b96-a547-650324836d48',path='/api/v3-bridge/jobs/'+job+'/status';
 const server=createApp(join(f.root,'publisher-unified.sqlite'),{unified:true,cloud:f.config,v3BridgeEnabled:true});t.after(()=>server.emit('close'));
 async function call(headers={}){const req=Readable.from([]);Object.assign(req,{url:path,method:'GET',headers:{host:f.config.host,...headers}});let code=200,body='';const res={setHeader(){},writeHead(status){code=status;},end(value=''){body+=value;}};await server.listeners('request')[0](req,res);return {code,body:JSON.parse(body)};}
 assert.equal((await call()).code,401);
 const ordinary=f.access.createToken({name:'ordinary',password,days:1,workspaces:['ws-a'],scopes:['jobs:read']});
 assert.equal((await call({authorization:'Bearer '+ordinary.token})).code,403);
 const appAccess=new PublisherAccess({...f.config,password});
 const scoped=appAccess.createToken({name:'relay',password,days:1,workspaces:['ws-a'],scopes:['v3:status'],site_project_id:'appgprj_6ad97a034fd08191a8399eeda10f048c',site_job_ids:[job]});
 assert.equal((await call({authorization:'Bearer '+scoped.token})).code,409);
 assert.equal((await call({authorization:'Bearer '+scoped.token})).body.error,'V3_BINDING_NOT_FOUND');
});
test('job-scoped app token stages one hashed image through the authenticated Mac HTTP route',async t=>{
 const f=fixture(t),job='e11a0a0b-36d1-4b96-a547-650324836d48',bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic')]);
 const sha=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
 const server=createApp(join(f.root,'publisher-unified.sqlite'),{unified:true,cloud:f.config,v3BridgeEnabled:true});t.after(()=>server.emit('close'));
 const token=new PublisherAccess(f.config).createToken({name:'upload one',password,days:1,workspaces:['ws-a'],scopes:['v3:upload'],site_project_id:'appgprj_6ad97a034fd08191a8399eeda10f048c',site_job_ids:[job]}).token;
 async function call(auth){const req=Readable.from([bytes]);Object.assign(req,{url:'/api/v3-bridge/jobs/'+job+'/media/0',method:'POST',headers:{host:f.config.host,'content-type':'application/octet-stream','x-v3-mime':'image/png','x-v3-sha256':sha,'x-v3-size':String(bytes.length),...(auth?{authorization:'Bearer '+auth}:{})}});let code=200,body='';const res={setHeader(){},writeHead(status){code=status;},end(value=''){body+=value;}};await server.listeners('request')[0](req,res);return {code,body:JSON.parse(body)};}
 assert.equal((await call(null)).code,401);
 const first=await call(token);assert.equal(first.code,200);assert.equal(first.body.sha256,sha);assert.equal(Object.hasOwn(first.body,'path'),false);
 const again=await call(token);assert.equal(again.code,200);assert.equal(again.body.duplicate,true);
});
test('real request handler offers form login without Basic challenge and accepts narrowly scoped public Bearer APIs without browser CSRF token',async t=>{const f=fixture(t),server=createApp(join(f.root,'publisher-unified.sqlite'),{unified:true,cloud:f.config});t.after(()=>{server.emit('close');});async function call(path,{method='GET',headers={},body}={}){const req=Readable.from(body===undefined?[]:Array.isArray(body)?body:[Buffer.from(body)]);Object.assign(req,{url:path,method,headers:{host:f.config.host,...headers}});const responseHeaders={};let code=200,text='';const res={setHeader(k,v){responseHeaders[k]=v;},writeHead(c,h={}){code=c;Object.assign(responseHeaders,h);},end(v=''){text+=v;}};await server.listeners('request')[0](req,res);return {code,text,headers:responseHeaders,json:()=>JSON.parse(text)};}
 const landing=await call('/');assert.equal(landing.code,303);assert.equal(landing.headers.Location,'/login');assert.equal((await call('/login')).code,200);assert.equal((await call('/api/state')).headers['WWW-Authenticate'],undefined);
 assert.equal((await call('/auth/login',{method:'POST',headers:{origin:'https://evil.example'},body:new URLSearchParams({username:'admin',password}).toString()})).code,403);
 const login=await call('/auth/login',{method:'POST',headers:{origin:f.config.origin},body:new URLSearchParams({username:'admin',password}).toString()});assert.equal(login.code,303);assert.match(login.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);assert.match(login.headers['Set-Cookie'],/Secure/);const cookie=login.headers['Set-Cookie'].split(';')[0];const state=(await call('/api/state',{headers:{cookie}})).json(),admin={cookie,origin:f.config.origin,'x-local-token':state.token,'content-type':'application/json'};
 assert.equal((await call('/api-response.js')).code,401);const helper=await call('/api-response.js',{headers:{cookie}});assert.equal(helper.code,200);assert.equal(helper.headers['Content-Type'],'text/javascript');assert.match(helper.text,/readApiJson/);
 const unicodePayload=Buffer.from(JSON.stringify({name:'中文客户'})),mid=unicodePayload.indexOf(Buffer.from('中'))+1;const unicodeResult=await call('/api/workspaces',{method:'POST',headers:admin,body:[unicodePayload.subarray(0,mid),unicodePayload.subarray(mid)]});assert.equal(unicodeResult.json().name,'中文客户');
 const malformed=await call('/api/access/password',{method:'POST',headers:admin,body:'{\"current_password\":\"test-secret-that-must-not-echo'});assert.equal(malformed.code,409);assert.ok(!malformed.text.includes('test-secret-that-must-not-echo'));
 const ws=(await call('/api/workspaces',{method:'POST',headers:admin,body:JSON.stringify({name:'Customer'})})).json();const created=await call('/api/access/tokens',{method:'POST',headers:admin,body:JSON.stringify({name:'API client',password,days:30,workspaces:[ws.id],scopes:['jobs:read']})});assert.equal(created.code,201);const bearer={authorization:'Bearer '+created.json().token};assert.equal((await call('/api/unified/workspaces/'+ws.id+'/jobs',{headers:bearer})).code,200);assert.equal((await call('/api/unified/workspaces/another/jobs',{headers:bearer})).code,403);assert.equal((await call('/api/access/tokens',{headers:bearer})).code,403);assert.equal((await call('/api/access/tokens',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).code,409);
});
