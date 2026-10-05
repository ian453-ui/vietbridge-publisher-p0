import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderDashboard} from '../src/web-ui.ts';
test('mounted dashboard scripts compile and freeze namespace/account for fetch and media',async()=>{
 const html=renderDashboard({prefix:'/publisher',workspace:'ws-vietbridge',accountId:'operator-a',platforms:['facebook'],executionEnabled:false,nonce:'test-nonce'});
 const scripts=[...html.matchAll(/<script nonce="test-nonce">([\s\S]*?)<\/script>/g)].map(m=>m[1]);assert.equal(scripts.length,2);
 scripts.forEach(source=>new vm.Script(source));
 const calls:Array<{url:string;init:any}>=[];
 const window={fetch:async(url:string,init:any)=>{calls.push({url,init});return {ok:true,json:async()=>({token:'fixture-token'})};}};
 const context=vm.createContext({window,URL,Headers,location:{href:'https://publisher.vietbridge.one/publisher/',origin:'https://publisher.vietbridge.one'},document:{addEventListener(){}}});
 new vm.Script(scripts[0]).runInContext(context);
 await window.fetch('/api/batches?workspace=wrong',{});
 assert.equal(calls[0].url,'/publisher/api/batches?workspace=ws-vietbridge&accountId=operator-a');
 await window.fetch('/api/tasks/execute',{method:'POST'});
 assert.equal(calls[1].url,'/api/state?workspace=ws-vietbridge');
 assert.equal(calls[2].init.headers.get('x-local-token'),'fixture-token');
 assert.equal(vm.runInContext("integrationUrl('/api/jobs/j/assets/a')",context),'/publisher/api/jobs/j/assets/a?workspace=ws-vietbridge&accountId=operator-a');
});
