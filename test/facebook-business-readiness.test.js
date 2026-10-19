import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {FacebookBusinessBrowser} from '../src/publisher-core/facebook-business-browser.ts';

// Unit observations advance logical time; OS scheduling is not a UI state change.
// Keep the same 35ms budget and all fail-closed assertions. Bounded hung reads
// still use their real timer and remain covered by the timeout negative case.
let logicalTime=0;beforeEach(t=>{logicalTime=0;t.mock.method(Date,'now',()=>logicalTime);});
function fixture(patch={}){
  const state={visible:true,enabled:true,count:1,body:'Frozen approved body',url:'https://business.facebook.com/latest/composer?asset_id=1459220443931651',destination:1,public:true,boost:false,photos:0,trialFailure:false,clickFailure:false,progress:0,uploading:false,occluded:false,animate:false,hang:false,...patch};
  let trials=0,clicks=0,pageCloses=0,disconnects=0,observations=0;
  const publish={async scrollIntoViewIfNeeded(){},async count(){return state.count;},async isVisible(){return state.visible;},async isEnabled(){return state.enabled;},async click(options){if(options.trial){trials++;state.afterTrial?.(state);if(state.trialFailure)throw Error('trial actionability timeout');}else{clicks++;if(state.clickFailure)throw Error('click outcome unknown');}}};
  const page={locator:selector=>selector,url:()=>state.url,title:async()=> 'Meta Business Suite',screenshot:async()=>Buffer.from('mock control png'),evaluate:async()=>{observations++;logicalTime+=1;if(state.hang)return new Promise(()=>{});state.onObservation?.(state,observations);return {at:new Date().toISOString(),count:state.count,visible:state.visible,enabled:state.enabled,rect:{x:state.animate?observations:10,y:10,width:100,height:30},occluded:state.occluded,obstruction:state.occluded?{tag:'div',role:'dialog'}:null,progress:state.progress,uploading:state.uploading,mediaCount:state.photos,mediaDecoded:state.mediaDecoded!==false,mediaNamesMatched:state.mediaNamesMatched!==false,mediaSignature:state.mediaSignature||'a'.repeat(64),viewport:{width:1000,height:700}};},getByLabel(){return {innerText:async()=>state.body};},getByRole(role,{name}={}){
    if(role==='combobox')return {count:async()=>state.destination};if(role==='radio')return {isChecked:async()=>state.public};if(role==='switch')return {isChecked:async()=>name==='Boost'&&state.boost};if(name==='Publish')return publish;if(name==='Remove photo')return {count:async()=>state.photos};throw Error('unexpected fixture locator');
  },async close(){pageCloses++;}};
  const browser=new FacebookBusinessBrowser({id:'a',page_id:'1459220443931651',page_name:'LP'},17921,'61594159443807');
  browser.readinessBudget={totalMs:35,callMs:8,intervalMs:1,stableSamples:3};browser.composer=page;browser.prepared={caption:'Frozen approved body',images:patch.expectedImages||0,video:false};browser.browser={close:async()=>{disconnects++;}};
  return {browser,state,get trials(){return trials;},get clicks(){return clicks;},get pageCloses(){return pageCloses;},get disconnects(){return disconnects;}};
}
test('readiness trial checks actionability without any final click and retains sanitized form evidence',async()=>{
  const f=fixture(),evidence=await f.browser.readiness();assert.equal(f.trials,1);assert.equal(f.clicks,0);assert.equal(evidence.actionabilityTrialPassed,true);assert.equal(evidence.bodyMatches,true);assert.equal(evidence.finalClickAttempted,false);assert.equal(JSON.stringify(evidence).includes('Frozen approved body'),false);
});
test('hidden/disabled/nonunique/unstable buttons cannot dispatch a final click',async()=>{
  for(const patch of [{visible:false},{enabled:false},{count:2},{trialFailure:true}]){const f=fixture(patch);await assert.rejects(()=>f.browser.submit());assert.equal(f.clicks,0);assert.equal(f.browser.failureEvidence().finalClickAttempted,false);await f.browser.close();assert.equal(f.pageCloses,0);assert.equal(f.disconnects,1);}
});
test('changed body/target/audience/media/boost fail before actionability or final click',async()=>{
  for(const patch of [{body:'Changed'}, {url:'https://business.facebook.com/latest/composer?asset_id=wrong'}, {destination:0}, {public:false}, {photos:1}, {boost:true}]){const f=fixture(patch);await assert.rejects(()=>f.browser.submit(),/核对失败/);assert.equal(f.trials,0);assert.equal(f.clicks,0);}
});
test('final click timeout preserves composer and diagnostic boundary without automatic retry',async()=>{
  const f=fixture({clickFailure:true});await assert.rejects(()=>f.browser.submit(),/unknown/);assert.equal(f.clicks,1);const evidence=f.browser.failureEvidence();assert.equal(evidence.finalClickAttempted,true);assert.equal(evidence.actionabilityTrialPassed,true);assert.equal(evidence.composerRetained,true);await f.browser.close();assert.equal(f.pageCloses,0);assert.equal(f.clicks,1);
});
test('completed click without independent publication proof still retains composer; verified readback permits cleanup',async()=>{
  const f=fixture();await f.browser.submit();assert.equal(f.clicks,1);assert.equal(f.browser.failureEvidence().clickCallCompleted,true);await f.browser.close();assert.equal(f.pageCloses,0);
  const g=fixture();g.browser.publishedMatch=async()=>({id:'123',url:'https://www.facebook.com/61594159443807/posts/123'});await g.browser.readback('Frozen approved body');await g.browser.close();assert.equal(g.pageCloses,1);
});

test('Page preparation reads the DOM document body when an extension adds another body',async()=>{
  const caption='Frozen approved body';let editorText='',formChecked=false,bodyRead=false;
  const editor={waitFor:async()=>{},fill:async value=>{editorText=value;},innerText:async()=>editorText};
  const page={url:()=> 'https://business.facebook.com/latest/composer?asset_id=1459220443931651',
    goto:async()=>{},waitForTimeout:async()=>{},getByLabel:()=>editor,
    locator:selector=>{if(selector==='body'||selector==='html > body')throw Error('strict mode: document and extension bodies');throw Error(`unexpected locator ${selector}`);},
    evaluate:async fn=>{assert.match(String(fn),/document\.body/);bodyRead=true;return 'Post to LP Public';},
    getByRole:(role,{name}={})=>{
      if(role==='combobox')return {count:async()=>1};
      if(role==='button'&&name==='Publish')return {isEnabled:async()=>true};
      if(role==='button'&&name==='Remove photo')return {count:async()=>0};
      if(role==='radio')return {isChecked:async()=>true};
      if(role==='switch')return {isChecked:async()=>false};
      throw Error(`unexpected role ${role}`);
    }};
  const browser=new FacebookBusinessBrowser({id:'a',page_id:'1459220443931651',page_name:'LP'},17921,'61594159443807');
  browser.browser={contexts:()=>[{newPage:async()=>page}]};browser.readiness=async()=>{formChecked=true;return {};};
  await browser.fill(caption,[]);assert.equal(editorText,caption);assert.equal(formChecked,true);assert.equal(bodyRead,true);
});

test('image uploading waits for observable completion; ongoing upload cannot dispatch',async()=>{
  const undecoded=fixture({mediaDecoded:false});await assert.rejects(()=>undecoded.browser.submit(),/IMAGE_PREVIEW_UNVERIFIED/);assert.equal(undecoded.clicks,0);
  const blocked=fixture({progress:1,uploading:true});await assert.rejects(()=>blocked.browser.submit(),/IMAGE_UPLOAD_INCOMPLETE/);assert.equal(blocked.clicks,0);assert.equal(blocked.trials,0);assert.equal(blocked.browser.failureEvidence().uploadState.progress,1);
  const ready=fixture({progress:1,uploading:true,onObservation(s,n){if(n===3){s.progress=0;s.uploading=false;}}});await ready.browser.submit();assert.equal(ready.clicks,1);assert.equal(ready.browser.failureEvidence().stableSamples,3);
});
test('animation, occlusion and unresponsive page produce distinct bounded diagnostics without dispatch',async()=>{
  for(const [patch,reason] of [[{animate:true},'PUBLISH_BUTTON_UNSTABLE'],[{occluded:true},'PUBLISH_BUTTON_OCCLUDED'],[{hang:true},'READINESS_OBSERVATION_TIMEOUT']]){
    const f=fixture(patch);await assert.rejects(()=>f.browser.submit(),new RegExp(reason));assert.equal(f.clicks,0);assert.equal(f.trials,0);const e=f.browser.failureEvidence();assert.equal(e.failureReason,reason);assert.equal(e.finalClickAttempted,false);assert.equal(e.safeUrl,'https://business.facebook.com/latest/composer?asset_id=1459220443931651');assert.equal(JSON.stringify(e).includes('Frozen approved body'),false);
    if(patch.occluded)assert.equal(e.screenshot,'DISABLED_FOR_PRIVACY');
  }
});
test('target, body and media changes during stable wait or trial prevent final dispatch',async()=>{
  for(const change of [s=>s.url='https://business.facebook.com/latest/composer?asset_id=999',s=>s.body='Changed during wait',s=>s.photos=1,s=>s.count=2]){
    const f=fixture({onObservation(s,n){if(n===2)change(s);}});await assert.rejects(()=>f.browser.submit());assert.equal(f.clicks,0);
    const g=fixture({afterTrial:change});await assert.rejects(()=>g.browser.submit());assert.equal(g.clicks,0);assert.equal(g.browser.failureEvidence().finalClickAttempted,false);
  }
});
test('diagnostics strip unexpected URL/query/title and skip screenshot on unsafe rectangle',async()=>{
 const f=fixture({url:'https://business.facebook.com/latest/composer?asset_id=999&token=private'});await assert.rejects(()=>f.browser.submit());const e=f.browser.failureEvidence();assert.equal(e.safeUrl,'https://business.facebook.com/latest/composer?asset_id=999');assert.equal(JSON.stringify(e).includes('private'),false);assert.equal(e.screenshot,'DISABLED_FOR_PRIVACY');assert.equal(e.buttonScreenshot,undefined);
});

test('one decoded approved photo succeeds while a missing decoder stays blocked',async()=>{
 const f=fixture({photos:1,expectedImages:1});await f.browser.submit();assert.equal(f.clicks,1);
 const g=fixture({photos:1,expectedImages:1,mediaDecoded:false});await assert.rejects(()=>g.browser.submit(),/IMAGE_PREVIEW_UNVERIFIED/);assert.equal(g.clicks,0);
});
test('upload restart or covering overlay during trial fails before dispatch',async()=>{
 for(const change of [s=>s.progress=1,s=>s.mediaDecoded=false,s=>s.occluded=true]){const f=fixture({afterTrial:change});await assert.rejects(()=>f.browser.submit());assert.equal(f.clicks,0);assert.equal(f.browser.failureEvidence().finalClickAttempted,false);}
});
test('actor verifier failure and changed form after identity recheck cannot dispatch',async()=>{
 const f=fixture();await assert.rejects(()=>f.browser.submit({verifyIdentity:async()=>{throw Error('actor changed');}}),/actor changed/);assert.equal(f.clicks,0);assert.equal(f.browser.failureEvidence().failureReason,'IDENTITY_RECHECK_FAILED');
 const g=fixture();await assert.rejects(()=>g.browser.submit({verifyIdentity:async()=>{g.state.body='changed';}}));assert.equal(g.clicks,0);
});

test('actor changes during the second trial or stabilization are checked again before dispatch',async()=>{
 for(const phase of ['trial','wait']){let trials=0,actor='approved',checks=0;const f=fixture({afterTrial(){trials++;if(phase==='trial'&&trials===2)actor='other';},onObservation(s,n){if(phase==='wait'&&trials===1&&n>=5)actor='other';}});await assert.rejects(()=>f.browser.submit({verifyIdentity:async()=>{checks++;if(actor!=='approved')throw Error('actor changed');}}));assert.equal(f.clicks,0);assert.equal(checks,2);}
});
test('same-count preview replacement or missing frozen-name binding cannot pass',async()=>{
 const f=fixture({photos:1,expectedImages:1,onObservation(s,n){if(n===2)s.mediaSignature='b'.repeat(64);}});await assert.rejects(()=>f.browser.submit(),/PREVIEW_CHANGED_OR_UNBOUND/);assert.equal(f.clicks,0);
 const g=fixture({photos:1,expectedImages:1,afterTrial(s){s.mediaSignature='b'.repeat(64);}});await assert.rejects(()=>g.browser.submit(),/PREVIEW_CHANGED_OR_UNBOUND/);assert.equal(g.clicks,0);
 const h=fixture({photos:1,expectedImages:1,mediaNamesMatched:false});await assert.rejects(()=>h.browser.submit(),/PREVIEW_CHANGED_OR_UNBOUND/);assert.equal(h.clicks,0);
});
