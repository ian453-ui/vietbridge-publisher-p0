export type UploadObservation={phase:'UPLOADING'|'PROCESSING'|'READY'|'REJECTED'|'UNOBSERVED';percent?:number;ready:boolean};
export function classifyChannelsUpload(text:string,enabled:boolean):UploadObservation{
 const percentages=[...text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].map(m=>Number(m[1])).filter(n=>n>=0&&n<=100);
 const percent=percentages.length===1?percentages[0]:undefined;
 if(/上传失败|网络出错|格式不支持|视频处理失败/u.test(text))return {phase:'REJECTED',percent,ready:false};
 if(/正在(?:转码|处理)|转码中|处理中/u.test(text))return {phase:'PROCESSING',percent,ready:false};
 if(/正在上传|上传中/u.test(text)||/取消上传/u.test(text)&&percent!==100)return {phase:'UPLOADING',percent,ready:false};
 return {phase:enabled?'READY':'UNOBSERVED',percent,ready:enabled};
}
/** All repeated actions are reads; progress does not authorize a submit. */
export async function observeChannelsUpload(options:{probe:()=>Promise<UploadObservation>;wait:(ms:number)=>Promise<void>;now?:()=>number;budgetMs?:number;stallMs?:number;readTimeoutMs?:number;onProgress?:(state:UploadObservation&{elapsedMs:number;readCount:number})=>void}){
 const now=options.now||Date.now,start=now(),budget=options.budgetMs??180000,stall=options.stallMs??60000;
 let lastProgress=start,previous:UploadObservation|undefined,reads=0;
 while(now()-start<budget){
  let timer:ReturnType<typeof setTimeout>|undefined;
  let state:UploadObservation;
  try{state=await Promise.race([options.probe(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('CHANNELS_UPLOAD_READ_TIMEOUT')),Math.min(options.readTimeoutMs??10000,budget-(now()-start)));})]);}
  finally{if(timer)clearTimeout(timer);}
  reads++;
  if(!previous||state.phase!==previous.phase||state.percent!==undefined&&(previous.percent===undefined||state.percent>previous.percent))lastProgress=now();
  options.onProgress?.({...state,elapsedMs:now()-start,readCount:reads});
  if(state.phase==='REJECTED')throw Error('CHANNELS_UPLOAD_REJECTED');
  if(state.ready)return state;
  previous=state;
  if(now()-lastProgress>=stall)throw Error('CHANNELS_UPLOAD_STALLED:'+state.phase);
  await options.wait(Math.min(1000*Math.min(reads,4),Math.max(0,budget-(now()-start))));
 }
 throw Error('CHANNELS_UPLOAD_TIMEOUT:'+previous?.phase);
}
