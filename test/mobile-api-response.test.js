import test from 'node:test';
import assert from 'node:assert/strict';
import {readApiJson} from '../src/api-response.js';

const response=(status,contentType,body,url='https://publisher.vietbridge.one/api/state')=>({
 status,ok:status>=200&&status<300,url,headers:{get:key=>key==='content-type'?contentType:null},
 json:async()=>{if(contentType.includes('html'))throw Error('HTML parsed as JSON');return body;}
});

test('HTML 200 and HTML 502 are connection errors, never parsed as customer data',async()=>{
 for(const status of [200,502])await assert.rejects(readApiJson(response(status,'text/html','<!DOCTYPE html>'),{label:'客户资料'}),error=>error.retryable&&error.message.includes('HTTP '+status)&&!error.message.includes('Unexpected token'));
});
test('redirect to login and JSON 401 identify an expired session',async()=>{
 for(const r of [response(200,'text/html','login','https://publisher.vietbridge.one/login'),response(401,'application/json',{error:'请登录'})])await assert.rejects(readApiJson(r),/重新登录 Publisher/);
});
test('JSON 403 gives permission error and valid JSON remains intact',async()=>{
 await assert.rejects(readApiJson(response(403,'application/json',{error:'denied'}),{label:'客户资料'}),/无权读取客户资料/);
 const value={workspaces:[{id:'A'}]};assert.equal(await readApiJson(response(200,'application/json; charset=utf-8',value)),value);
});
