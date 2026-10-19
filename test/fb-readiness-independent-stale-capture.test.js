import test from 'node:test';
import assert from 'node:assert/strict';
import {observeReadiness,captureReadinessFailure,boundedRead} from '../src/publisher-core/facebook-readiness-observation.ts';

function domPage({decoded=true,progress=0,overlay=false,uploading=false}={}){
  const image={complete:decoded,naturalWidth:decoded?1080:0};
  const container={parentElement:null,querySelectorAll(selector){return selector==='img'?[image]:[];}};
  const button={textContent:'Publish',tagName:'DIV',getAttribute:()=>null,hasAttribute:()=>false,contains:()=>false,getBoundingClientRect:()=>({x:10,y:20,width:90,height:30})};
  const remove={textContent:'Remove photo',parentElement:container,getAttribute:()=>null};
  const obstruction={tagName:'DIV',getAttribute:name=>name==='role'?'dialog':null};
  const document={body:{innerText:uploading?'Uploading':'private frozen body'},querySelectorAll(selector){if(selector==='[role="progressbar"]')return Array(progress).fill({});return [button,remove];},elementFromPoint:()=>overlay?obstruction:button};
  return {async evaluate(fn){const names=['document','getComputedStyle','innerWidth','innerHeight'],before=names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);Object.assign(globalThis,{document,getComputedStyle:()=>({visibility:'visible',display:'block'}),innerWidth:1000,innerHeight:700});try{return fn();}finally{for(const [k,d] of before){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}}};
}
test('independent: diagnostic title delay may expose private overlay in stale button clip',async()=>{const sample=await observeReadiness(domPage());let overlay=false,captures=0;const page={url:()=> 'https://business.facebook.com/latest/composer?asset_id=123',title:async()=>{overlay=true;return 'Meta Business Suite';},locator:s=>s,screenshot:async()=>{captures++;assert.equal(overlay,true);return Buffer.from('SYNTHETIC_PRIVATE_OVERLAY_PIXELS');}};const evidence={readinessSamples:[sample]};await captureReadinessFailure(page,evidence,20);console.log('STALE SCREENSHOT',JSON.stringify({captures,scope:evidence.buttonScreenshot?.scope,storedSyntheticPrivatePixels:Buffer.from(evidence.buttonScreenshot?.base64||'','base64').toString().includes('PRIVATE_OVERLAY')}));assert.equal(captures,0);});
