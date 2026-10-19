import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserDriver} from '../src/unified-drivers.js';
import {observeRetainedComposer} from '../src/composer-observation.js';
const snapshot={targetPageId:'1459220443931651',operatorActorId:'61594159443807',body:'frozen',expectedIdentity:'LP',media:['/disposable/photo.png']};
function fixture({count=1,wrongForm=false,hang=false,changeUrl=false}={}){
 let calls=0;const forbidden=()=>{throw Error('forbidden side effect');},page={url:()=>changeUrl&&calls>1?'https://business.facebook.com/latest/composer?asset_id=999':'https://business.facebook.com/latest/composer?asset_id='+snapshot.targetPageId,goto:forbidden,close:forbidden,click:forbidden,fill:forbidden,screenshot:forbidden,scrollIntoViewIfNeeded:forbidden,evaluate:async(fn,args)=>{calls++;if(hang)return new Promise(()=>{});if(!Array.isArray(args))return {editorCount:1,bodyMatches:!wrongForm,destinationCount:1};assert.deepEqual(args,['photo.png']);return {at:'now',count:1,visible:true,enabled:true,rect:{x:1,y:1,width:10,height:10},occluded:false,obstruction:null,progress:0,uploading:false,mediaCount:1,mediaDecoded:true,mediaNamesMatched:true,mediaSignature:'a'.repeat(64),viewport:{width:100,height:100}};}};
 return {context:{pages:()=>Array(count).fill(page),newPage:forbidden},page};
}
test('only existing composer is read, with bounded structural samples and no live actor/absence claim',async()=>{
 const f=fixture(),stages=[];const r=await observeRetainedComposer(f.context,snapshot,x=>stages.push(x.stage),{stepMs:20,samples:3,intervalMs:1});assert.equal(r.samples.length,3);assert.equal(r.form.bodyMatches,true);assert.equal(r.activeActorVerified,false);assert.equal(r.absenceProven,false);assert.equal(r.conclusion,'INCOMPLETE');assert.equal(JSON.stringify(r).includes('frozen'),false);assert.equal(JSON.stringify(r).includes('/disposable'),false);assert.deepEqual(stages,['SELECT_EXISTING_COMPOSER','READ_ONLY_SAMPLING','READ_ONLY_SAMPLING','READ_ONLY_SAMPLING']);
});
test('missing/ambiguous composer, changed form/URL and stalled DOM fail without any UI action',async()=>{
 for(const [options,reason] of [[{count:0},'MISSING_OR_AMBIGUOUS'],[{count:2},'MISSING_OR_AMBIGUOUS'],[{wrongForm:true},'FORM_MISMATCH'],[{changeUrl:true},'COMPOSER_CHANGED'],[{hang:true},'OBSERVATION_TIMEOUT']]){
  const f=fixture(options);await assert.rejects(()=>observeRetainedComposer(f.context,snapshot,()=>{},{stepMs:5,samples:3,intervalMs:1}),new RegExp(reason));
 }
});

test('real BrowserDriver observation uses frozen-profile validation and connection only, never identity navigation',async()=>{
 const f=fixture(),s={...snapshot,workspace:'w',accountId:'a',externalId:snapshot.operatorActorId,profileId:'p',profileDir:'/unused',cdpPort:17921};let connects=0,checks=0;const forbidden=()=>{throw Error('forbidden identity navigation');};const browser={connect:async()=>{connects++;},diagnosticContext:()=>f.context,close:async()=>{}};const facebook={assertDiagnosticProfile:async value=>{checks++;assert.equal(value,s);},inspect:forbidden,inspectDiagnostic:forbidden};const driver=new BrowserDriver(s,facebook,{browser});const result=await driver.observeComposer(s,()=>{});assert.equal(checks,1);assert.equal(connects,1);assert.equal(result.samples.length,3);assert.equal(result.activeActorVerified,false);facebook.assertDiagnosticProfile=async()=>{throw Error('private path/token');};await assert.rejects(()=>driver.observeComposer(s,()=>{}),/PROFILE_MAPPING_OR_CONNECTION_BLOCKED/);assert.equal(connects,1);
});
