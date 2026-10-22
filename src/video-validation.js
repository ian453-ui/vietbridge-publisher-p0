import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const fail=code=>{throw Error(code);};
function run(binary,args,timeout){
 const result=spawnSync(binary,args,{encoding:'utf8',timeout,maxBuffer:256*1024,stdio:['ignore','pipe','pipe']});
 if(result.error?.code==='ENOENT')fail('VIDEO_DECODER_UNAVAILABLE');
 if(result.error||result.signal)fail('VIDEO_VALIDATION_RESOURCE_LIMIT');
 if(result.status!==0||result.stderr.trim())fail('VIDEO_DECODE_INVALID');
 return result.stdout;
}

/** Decode a private snapshot of the exact hashed bytes, never a caller URL/path. */
export function validateVideo(bytes,extension,{ffprobe='ffprobe',ffmpeg='ffmpeg'}={}){
 const demuxer={'.mp4':'mov','.mov':'mov','.webm':'matroska'}[extension];
 if(!demuxer||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>100*1024*1024)fail('VIDEO_FORMAT_OR_SIZE_INVALID');
 const directory=mkdtempSync(join(tmpdir(),'publisher-video-'));
 try{
  const file=join(directory,'artifact'+extension);writeFileSync(file,bytes,{flag:'wx',mode:0o600});
  // Fixed demuxer and file-only protocol exclude playlists and network inputs.
  const input=['-protocol_whitelist','file','-f',demuxer,'-threads','1'];
  let probe;try{probe=JSON.parse(run(ffprobe,['-v','error',...input,'-show_format','-show_streams','-of','json',file],5000));}catch(error){if(error.message.startsWith('VIDEO_'))throw error;fail('VIDEO_PROBE_INVALID');}
  const streams=probe.streams||[],videos=streams.filter(s=>s.codec_type==='video'&&!s.disposition?.attached_pic),audio=streams.filter(s=>s.codec_type==='audio');
  if(videos.length!==1||audio.length>1||streams.length!==videos.length+audio.length)fail('VIDEO_STREAMS_UNSUPPORTED');
  const video=videos[0],duration=Number(probe.format?.duration),width=Number(video.width),height=Number(video.height);
  if(!video.codec_name||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>3840*2160||!Number.isFinite(duration)||duration<=0||duration>600)fail('VIDEO_METADATA_OR_LIMIT_INVALID');
  // No -t or frame cap: success requires reaching EOF, with all A/V decoded.
  const progress=run(ffmpeg,['-hide_banner','-v','error','-nostdin','-xerror','-err_detect','explode',...input,'-i',file,'-map','0:v:0','-map','0:a?','-threads','1','-progress','pipe:1','-nostats','-f','null','-'],20000);
  const frames=Number([...progress.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]);
  if(!progress.includes('progress=end')||!Number.isSafeInteger(frames)||frames<1||frames>60000)fail('VIDEO_EMPTY_OR_EXCESSIVE_FRAMES');
  const decodedDuration=Number([...progress.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1])/1000000;
  if(!Number.isFinite(decodedDuration)||decodedDuration<=0||Math.abs(decodedDuration-duration)>Math.max(0.25,duration*0.01))fail('VIDEO_DURATION_MISMATCH');
  return {level:'VIDEO_DECODED',decoded:true,playback_verified:false,duration_verified:true,
   duration_seconds:duration,decoded_duration_seconds:decodedDuration,width,height,codec:video.codec_name,decoded_frames:frames,
   audio_present:audio.length>0,audio_decoded:audio.length>0,
   browser_playback_verified:false,subtitle_alignment_verified:false};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
