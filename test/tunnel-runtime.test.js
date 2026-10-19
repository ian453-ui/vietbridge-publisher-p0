import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudRuntime,authenticate} from '../src/cloud-runtime.js';
const env={PUBLISHER_MODE:'mac-tunnel',PUBLIC_ORIGIN:'https://publisher.vietbridge.one',ADMIN_PASSWORD:'disposable-test-password-at-least-24',DATA_DIR:'/tmp/disposable-data'};
test('Mac Tunnel requires the one public domain and credentials while enabling local execution',()=>{
 const runtime=cloudRuntime(env);
 assert.equal(runtime.executionConnected,true);assert.equal(runtime.mode,'mac-tunnel');
 assert.equal(cloudRuntime({...env,PUBLISHER_MODE:'cloud'}).executionConnected,false);
 assert.throws(()=>cloudRuntime({...env,PUBLIC_ORIGIN:'https://second.example'}),/唯一外网域名/);
 assert.throws(()=>cloudRuntime({...env,ADMIN_PASSWORD:'12345'}),/6/);
 assert.equal(cloudRuntime({...env,ADMIN_PASSWORD:'123456'}).password,'123456');
 let status;
 const res={writeHead:code=>status=code,end(){}};
 assert.equal(authenticate({headers:{}},res,runtime),false);assert.equal(status,401);
 assert.equal(authenticate({headers:{authorization:'Basic '+Buffer.from(runtime.user+':'+runtime.password).toString('base64')}},res,runtime),true);
});
