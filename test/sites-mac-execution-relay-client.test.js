import test from 'node:test';
import assert from 'node:assert/strict';
import {MacExecutionRelayClient} from '../src/sites/mac-execution-relay-client.js';

const origin='https://publisher.vietbridge.one',siteJob='e11a0a0b-36d1-4b96-a547-650324836d48';
const token='vb_app_'+'x'.repeat(48),localHash='a'.repeat(64),siteHash='b'.repeat(64);
function result(operation,overrides={}){const url=origin+'/api/v3-bridge/jobs/'+siteJob+'/'+operation,response=new Response(JSON.stringify({site_job_id:siteJob,local_snapshot_hash:localHash,site_snapshot_hash:siteHash,state:'UNKNOWN',...overrides}),{status:200,headers:{'Content-Type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;}
test('Site server relay sends one exact command with server-only bearer and reads the same frozen hashes',async()=>{
 const calls=[],client=new MacExecutionRelayClient({origin,token,fetchImpl:async(url,options)=>{calls.push({url,options});return result('dispatch');}});
 const answer=await client.dispatch(siteJob,{confirm:true,local_snapshot_hash:localHash,site_snapshot_hash:siteHash});
 assert.equal(answer.state,'UNKNOWN');assert.equal(calls.length,1);
 assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.method,'POST');
 assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);
 assert.deepEqual(JSON.parse(calls[0].options.body),{confirm:true,local_snapshot_hash:localHash,site_snapshot_hash:siteHash});
});
test('Site relay rejects unsafe origin, uncertain network outcome and mismatched readback without replay',async()=>{
 assert.throws(()=>new MacExecutionRelayClient({origin:'https://evil.example',token}),/V3_RELAY_CONFIGURATION_INVALID/);
 let calls=0;const uncertain=new MacExecutionRelayClient({origin,token,fetchImpl:async()=>{calls++;throw Error('connection lost');}});
 await assert.rejects(uncertain.dispatch(siteJob,{confirm:true,local_snapshot_hash:localHash,site_snapshot_hash:siteHash}),/V3_RELAY_OUTCOME_UNKNOWN/);assert.equal(calls,1);
 const mismatched=new MacExecutionRelayClient({origin,token,fetchImpl:async()=>result('dispatch',{site_snapshot_hash:'c'.repeat(64)})});
 await assert.rejects(mismatched.dispatch(siteJob,{confirm:true,local_snapshot_hash:localHash,site_snapshot_hash:siteHash}),/V3_RELAY_READBACK_MISMATCH/);
});
test('Site server uploads only bounded, hashed media to its exact job and checks the staging receipt',async()=>{
 const sha256='c'.repeat(64),bytes=new Uint8Array([137,80,78,71,13,10,26,10,1]),calls=[];
 const client=new MacExecutionRelayClient({origin,token,fetchImpl:async(url,options)=>{calls.push({url,options});const response=new Response(JSON.stringify({site_job_id:siteJob,ordinal:0,mime:'image/png',sha256,size:bytes.length,duplicate:false}),{headers:{'Content-Type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;}});
 const receipt=await client.upload(siteJob,0,{mime:'image/png',sha256,size:bytes.length,body:bytes});assert.equal(receipt.duplicate,false);
 assert.equal(calls.length,1);assert.equal(calls[0].options.headers['X-V3-Sha256'],sha256);assert.equal(calls[0].options.redirect,'error');
 await assert.rejects(client.upload(siteJob,20,{mime:'image/png',sha256,size:bytes.length,body:bytes}),/V3_RELAY_MEDIA_INVALID/);
});
