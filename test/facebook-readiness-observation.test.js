import test from 'node:test';
import assert from 'node:assert/strict';
import {observeReadiness,captureReadinessFailure,boundedRead,waitForImageReadiness} from '../src/publisher-core/facebook-readiness-observation.ts';

function domPage({decoded=true,progress=0,overlay=false,uploading=false,controls=1,avatar=false,shared=true,sameSource=false,zeroWidth=false,dimensionsOnly=false}={}){
  const image={complete:decoded,naturalWidth:decoded?1080:0,naturalHeight:1350,src:'blob:approved-photo',alt:avatar?'Profile picture':dimensionsOnly?'':'photo.png'};
  let remove,removals;const container={textContent:dimensionsOnly?'1080 x 1350':'photo.png',parentElement:null,querySelectorAll(selector){return selector==='img'?[image]:selector==='[role=\"button\"],button'?removals:[];}};
  const button={textContent:'Publish',tagName:'DIV',getAttribute:()=>null,hasAttribute:()=>false,contains:()=>false,getBoundingClientRect:()=>({x:10,y:20,width:90,height:30})};
  remove={textContent:'Remove photo'+(zeroWidth?'\u200b':''),parentElement:container,getAttribute:()=>null};
  removals=Array.from({length:controls},()=>({...remove}));
  if(!shared)removals=removals.map((control,i)=>{const img={...image,src:sameSource?image.src:image.src+i,alt:i?'second.png':'photo.png'};const card={...container,textContent:img.alt,querySelectorAll(selector){return selector==='img'?[img]:selector==='[role=\"button\"],button'?[control]:[];}};control.parentElement=card;return control;});
  const obstruction={tagName:'DIV',getAttribute:name=>name==='role'?'dialog':null};
  const document={body:{innerText:uploading?'Uploading':'private frozen body'},querySelectorAll(selector){if(selector==='[role="progressbar"]')return Array(progress).fill({});return [button,...removals];},elementFromPoint:()=>overlay?obstruction:button};
  return {async evaluate(fn,args=[]){const names=['document','getComputedStyle','innerWidth','innerHeight'],before=names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);Object.assign(globalThis,{document,getComputedStyle:()=>({visibility:'visible',display:'block'}),innerWidth:1000,innerHeight:700});try{return await fn(args);}finally{for(const [k,d] of before){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}}};
}
test('DOM observation verifies decoded attachment preview and upload state without retaining body/HTML',async()=>{
 const good=await observeReadiness(domPage());assert.equal(good.mediaDecoded,true);assert.equal(good.mediaCount,1);assert.equal(good.occluded,false);
 const pending=await observeReadiness(domPage({decoded:false,progress:1,uploading:true}));assert.equal(pending.mediaDecoded,false);assert.equal(pending.progress,1);assert.equal(pending.uploading,true);assert.equal(JSON.stringify(pending).includes('private'),false);
 const covered=await observeReadiness(domPage({overlay:true}));assert.equal(covered.occluded,true);assert.deepEqual(covered.obstruction,{tag:'div',role:'dialog'});
});
test('title delay, changed overlay and position can never capture or retain screenshot pixels',async()=>{
 let captures=0;const page={url:()=> 'https://business.facebook.com/latest/composer?asset_id=123&token=secret',title:async()=> 'private account title',screenshot:async()=>{captures++;return Buffer.from('SYNTHETIC_PRIVATE_OVERLAY_PIXELS');}};
 const sample=await observeReadiness(domPage()),evidence={readinessSamples:[sample],buttonScreenshot:{base64:'old'}};await captureReadinessFailure(page,evidence,20);assert.equal(captures,0);assert.equal(evidence.pageTitle,'OTHER');assert.equal(evidence.safeUrl,'https://business.facebook.com/latest/composer?asset_id=123');assert.equal(evidence.buttonScreenshot,undefined);assert.equal(evidence.screenshot,'DISABLED_FOR_PRIVACY');assert.equal(JSON.stringify(evidence).includes('secret'),false);
 const hung={...page,title:()=>new Promise(()=>{}),screenshot:()=>new Promise(()=>{})};const failure={readinessSamples:[sample]};await captureReadinessFailure(hung,failure,5);assert.equal(failure.titleUnavailable,true);assert.equal(captures,0);assert.equal(failure.screenshot,'DISABLED_FOR_PRIVACY');
});
test('unresponsive read has a finite deadline and never initiates a retry',async()=>{
 let calls=0;await assert.rejects(()=>boundedRead(()=>{calls++;return new Promise(()=>{});},5),/OBSERVATION_TIMEOUT/);assert.equal(calls,1);
});

test('exclusive photo card and frozen filename bind; shared preview and avatar borrowing fail closed',async()=>{
 const good=await observeReadiness(domPage(),['photo.png']);assert.equal(good.mediaDecoded,true);assert.equal(good.mediaNamesMatched,true);assert.match(good.mediaSignature,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(good).includes('blob:approved-photo'),false);
 const shared=await observeReadiness(domPage({controls:2}),['photo.png','second.png']);assert.equal(shared.mediaDecoded,false);await assert.rejects(()=>waitForImageReadiness(domPage({controls:2}),2,{}, {totalMs:20,callMs:10,intervalMs:1,stableSamples:3},['photo.png','second.png']));
 const avatar=await observeReadiness(domPage({avatar:true}),['photo.png']);assert.equal(avatar.mediaDecoded,false);
 const wrong=await observeReadiness(domPage(),['other.png']);assert.equal(wrong.mediaNamesMatched,false);
});

test('two exclusive independently bound previews pass; duplicate preview source is refused',async()=>{
 const good=await observeReadiness(domPage({controls:2,shared:false}),['photo.png','second.png']);assert.equal(good.mediaDecoded,true);assert.equal(good.mediaNamesMatched,true);
 const reused=await observeReadiness(domPage({controls:2,shared:false,sameSource:true}),['photo.png','second.png']);assert.equal(reused.mediaDecoded,false);
});

test('Meta zero-width photo label and dimensions-only card remain bound to the approved PNG',async()=>{
 const page=domPage({zeroWidth:true,dimensionsOnly:true});
 const valid=await observeReadiness(page,['frozen.png'],[{width:1080,height:1350}]);
 assert.equal(valid.mediaCount,1);assert.equal(valid.mediaDecoded,true);assert.equal(valid.mediaNamesMatched,true);
 const wrong=await observeReadiness(page,['frozen.png'],[{width:900,height:1200}]);assert.equal(wrong.mediaNamesMatched,false);
});
