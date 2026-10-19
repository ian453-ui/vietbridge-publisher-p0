import type {Page} from 'playwright-core';

export type ReadinessObservation = {at:string;count:number;visible:boolean;enabled:boolean;rect:null|{x:number;y:number;width:number;height:number};occluded:boolean;obstruction:null|{tag:string;role:string};progress:number;uploading:boolean;mediaCount:number;mediaDecoded:boolean;mediaSignature?:string;mediaNamesMatched?:boolean;viewport:{width:number;height:number}};
export type ReadinessBudget = {totalMs:number;callMs:number;intervalMs:number;stableSamples:number};
export const defaultReadinessBudget:ReadinessBudget={totalMs:12000,callMs:1500,intervalMs:250,stableSamples:3};

// Timeouts never retry an action. All observations are read-only and return no body,
// account labels, DOM HTML, cookies, storage, network payloads or arbitrary URLs.
export async function boundedRead<T>(operation:()=>Promise<T>,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('READINESS_OBSERVATION_TIMEOUT')),Math.max(1,ms));})]);}
  finally{clearTimeout(timer!);}
}
export function safeComposerUrl(value:string):string|null{
  try{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='business.facebook.com'||!u.pathname.startsWith('/latest/composer'))return null;const id=u.searchParams.get('asset_id');return /^\d+$/.test(id||'')?`https://business.facebook.com/latest/composer?asset_id=${id}`:null;}catch{return null;}
}
export async function observeReadiness(page:Page,expectedNames:string[]=[],expectedDimensions:Array<{width:number;height:number}|null>=[]):Promise<ReadinessObservation>{
  return page.evaluate(async({expectedNames,expectedDimensions}={expectedNames:[],expectedDimensions:[]})=>{
    const label=(e:Element)=>(e.getAttribute('aria-label')||e.textContent||'').replace(/[\u200b-\u200d\ufeff]/gu,'').trim();
    const buttons=[...document.querySelectorAll('[role="button"],button')].filter(e=>label(e)==='Publish');
    const e=buttons.length===1?buttons[0]:null,r=e?.getBoundingClientRect(),style=e?getComputedStyle(e):null;
    const rect=r?{x:r.x,y:r.y,width:r.width,height:r.height}:null;
    const visible=Boolean(r&&r.width>0&&r.height>0&&style?.visibility!=='hidden'&&style?.display!=='none');
    const enabled=Boolean(e&&!e.hasAttribute('disabled')&&e.getAttribute('aria-disabled')!=='true');
    const cx=r?r.x+r.width/2:0,cy=r?r.y+r.height/2:0;
    const hit=r&&cx>=0&&cy>=0&&cx<innerWidth&&cy<innerHeight?document.elementFromPoint(cx,cy):null;
    const occluded=Boolean(e&&r&&(!hit||!(e===hit||e.contains(hit))));
    const role=hit?.getAttribute('role')||'';
    const obstruction=occluded&&hit?{tag:hit.tagName.toLowerCase(),role:/^[a-z-]{0,32}$/.test(role)?role:''}:null;
    const text=document.body?.innerText||'';
    const visibleProgress=[...document.querySelectorAll('[role="progressbar"]')].filter(e=>{const r=e.getBoundingClientRect?.();return !r||r.width>0&&r.height>0;});
    const removals=[...document.querySelectorAll('[role="button"],button')].filter(e=>label(e)==='Remove photo');
    // A removal control alone can exist before upload/preview completion.
    // Require a decoded image in its local media container, never the page's
    // unrelated avatar. Unsupported attachment DOM fails closed.
    const previews:HTMLImageElement[]=[];const containers:Element[]=[];const mediaAssociations:Array<Record<string,unknown>>=[];
    const mediaDecoded=removals.map((button,index)=>{
      let parent=button.parentElement;
      for(let depth=0;parent&&depth<4;depth++,parent=parent.parentElement){
        if(parent===document.body||parent.querySelectorAll('[role="textbox"],textarea,input').length)break;
        const images=[...parent.querySelectorAll('img')];
        if(images.length){
          const controls=[...parent.querySelectorAll('[role="button"],button')].filter(e=>label(e)==='Remove photo');
          const image=images[0];
          mediaAssociations.push({index,controlCount:controls.length,previewCount:images.length,decoded:images.every(img=>img.complete&&img.naturalWidth>0),exclusive:images.length===1&&controls.length===1&&controls[0]===button&&!containers.includes(parent)&&!previews.includes(image)});
          if(images.length!==1||controls.length!==1||controls[0]!==button||containers.includes(parent)||previews.includes(image)||!image.complete||image.naturalWidth<=0||parent.querySelectorAll('[role="progressbar"]').length)return false;
          // Unrelated avatar or unknown/non-media URL is not upload evidence.
          const src=image.currentSrc||image.src||'';
          if(previews.some(other=>(other.currentSrc||other.src)===src))return false;
          if(!/^(blob:|data:image\/|https:\/\/[^/]+(?:fbcdn\.net|facebook\.com)\/)/i.test(src)||/avatar|profile picture/i.test(image.alt||''))return false;
          containers.push(parent);previews.push(image);return true;
        }
      }
      mediaAssociations.push({index,controlCount:null,previewCount:0,decoded:false,exclusive:false});return false;
    }).every(Boolean);
    const signatures=previews.map(image=>[image.currentSrc||image.src,image.naturalWidth,image.naturalHeight]);
    const mediaSignature=mediaDecoded?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(signatures))))).map(n=>n.toString(16).padStart(2,'0')).join(''):undefined;
    return {at:new Date().toISOString(),frameScope:'MAIN_FRAME',childFrameCount:document.querySelectorAll('iframe').length,count:buttons.length,visible,enabled,rect,occluded,obstruction,
      progress:visibleProgress.length,
      uploading:/Uploading|Processing (?:video|photo|image)|上传中|处理中|Đang tải|Đang xử lý/iu.test(text),
      mediaCount:removals.length,mediaDecoded,mediaSignature,mediaAssociations,
      mediaNamesMatched:expectedNames.length===containers.length&&new Set(expectedNames).size===expectedNames.length&&containers.every((card,i)=>{
        const name=expectedNames[i],dimension=expectedDimensions[i],text=(card.textContent||'').replace(/[\u200b-\u200d\ufeff]/gu,'');
        const named=Boolean(name&&(text.split(/\s+/).includes(name)||(previews[i].alt||'')===name));
        // Meta currently hides the filename and shows only dimensions. This
        // fallback requires the exact decoded PNG dimensions, visible card
        // dimensions, and the exclusive photo/remove-control association.
        const measured=Boolean(dimension&&previews[i].naturalWidth===dimension.width&&previews[i].naturalHeight===dimension.height&&text.includes(`${dimension.width} x ${dimension.height}`));
        return named||measured;
      }),
      viewport:{width:innerWidth,height:innerHeight}};
  },{expectedNames,expectedDimensions});
}
export async function waitForImageReadiness(page:Page,images:number,evidence:Record<string,unknown>,budget:ReadinessBudget=defaultReadinessBudget,expectedNames:string[]=[],expectedDimensions:Array<{width:number;height:number}|null>=[]):Promise<void>{
  const deadline=Date.now()+budget.totalMs,samples:ReadinessObservation[]=[];evidence.readinessSamples=samples;
  let stable=0,last:ReadinessObservation|undefined,reason='READINESS_NOT_READY';
  while(Date.now()<deadline){
    let current:ReadinessObservation;
    try{current=await boundedRead(()=>observeReadiness(page,expectedNames,expectedDimensions),Math.min(budget.callMs,deadline-Date.now()));}
    catch{evidence.failureReason='READINESS_OBSERVATION_TIMEOUT';throw Error('READINESS_OBSERVATION_TIMEOUT');}
    // Keep bounded historical samples, including the last observation.
    samples.push(current);if(samples.length>24)samples.splice(1,1);
    if(current.count!==1){evidence.failureReason='PUBLISH_BUTTON_NOT_UNIQUE';throw Error('PUBLISH_BUTTON_NOT_UNIQUE');}
    if(current.mediaCount!==images){evidence.failureReason='MEDIA_COUNT_CHANGED';throw Error('MEDIA_COUNT_CHANGED');}
    if(images&&current.mediaDecoded&&(!current.mediaNamesMatched||!/^[a-f0-9]{64}$/.test(current.mediaSignature||'')||evidence.previewSignature&&evidence.previewSignature!==current.mediaSignature)){evidence.failureReason='MEDIA_PREVIEW_CHANGED_OR_UNBOUND';throw Error('MEDIA_PREVIEW_CHANGED_OR_UNBOUND');}
    if(images&&current.mediaDecoded)evidence.previewSignature=current.mediaSignature;
    const mediaReady=current.progress===0&&!current.uploading&&current.mediaDecoded;
    const same=Boolean(last?.rect&&current.rect&&Object.keys(current.rect).every(k=>Math.abs(current.rect![k as keyof NonNullable<ReadinessObservation['rect']>]-last!.rect![k as keyof NonNullable<ReadinessObservation['rect']>])<=0.5));
    const ready=mediaReady&&current.visible&&current.enabled&&!current.occluded;
    stable=ready?(same?stable+1:1):0;
    reason=current.progress||current.uploading?'IMAGE_UPLOAD_INCOMPLETE':!current.mediaDecoded?'IMAGE_PREVIEW_UNVERIFIED':!current.visible?'PUBLISH_BUTTON_NOT_VISIBLE':!current.enabled?'PUBLISH_BUTTON_DISABLED':current.occluded?'PUBLISH_BUTTON_OCCLUDED':'PUBLISH_BUTTON_UNSTABLE';
    evidence.uploadState={progress:current.progress,uploading:current.uploading,mediaCount:current.mediaCount,mediaDecoded:current.mediaDecoded};
    if(stable>=budget.stableSamples){evidence.stableSamples=stable;return;}
    last=current;await new Promise(resolve=>setTimeout(resolve,Math.min(budget.intervalMs,Math.max(0,deadline-Date.now()))));
  }
  evidence.failureReason=reason;throw Error(reason);
}
export async function captureReadinessFailure(page:Page,evidence:Record<string,unknown>,callMs=1500):Promise<void>{
  try{evidence.safeUrl=safeComposerUrl(page.url());}catch{evidence.safeUrl=null;}
  if(!(evidence.readinessSamples as ReadinessObservation[]|undefined)?.length){
    try{evidence.readinessSamples=[await boundedRead(()=>observeReadiness(page),callMs)];}catch{evidence.observationUnavailable=true;}
  }
  // Retain only an expected product title, never arbitrary page title contents.
  try{const title=await boundedRead(()=>page.title(),callMs);evidence.pageTitle=title==='Meta Business Suite'?title:'OTHER';}catch{evidence.titleUnavailable=true;}
  evidence.screenshot='DISABLED_FOR_PRIVACY';
  delete evidence.buttonScreenshot;
}
export async function recheckImageReadiness(page:Page,images:number,evidence:Record<string,unknown>,callMs:number,expectedNames:string[]=[],expectedDimensions:Array<{width:number;height:number}|null>=[]):Promise<void>{
  const last=(evidence.readinessSamples as ReadinessObservation[]|undefined)?.at(-1);
  const current=await boundedRead(()=>observeReadiness(page,expectedNames,expectedDimensions),callMs);evidence.afterTrialObservation=current;
  const stable=Boolean(last?.rect&&current.rect&&Object.keys(current.rect).every(k=>Math.abs(current.rect![k as keyof NonNullable<ReadinessObservation['rect']>]-last.rect![k as keyof NonNullable<ReadinessObservation['rect']>])<=0.5));
  const reason=images&&(!current.mediaNamesMatched||!current.mediaSignature||current.mediaSignature!==evidence.previewSignature)?'MEDIA_PREVIEW_CHANGED_OR_UNBOUND':current.count!==1?'PUBLISH_BUTTON_NOT_UNIQUE':current.mediaCount!==images?'MEDIA_COUNT_CHANGED':current.progress||current.uploading?'IMAGE_UPLOAD_INCOMPLETE':!current.mediaDecoded?'IMAGE_PREVIEW_UNVERIFIED':current.occluded?'PUBLISH_BUTTON_OCCLUDED':!current.visible||!current.enabled?'PUBLISH_BUTTON_NOT_READY':!stable?'PUBLISH_BUTTON_UNSTABLE':null;
  if(reason){evidence.failureReason=reason;throw Error(reason);}
}
