import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
export function syntheticVideo({audio=false,audioOnly=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'v3-video-fixture-'));
 try{
  const path=join(dir,'sample.mp4'),args=['-hide_banner','-loglevel','error'];
  if(!audioOnly)args.push('-f','lavfi','-i','color=c=blue:s=160x120:r=10:d=1');
  if(audio||audioOnly)args.push('-f','lavfi','-i','sine=frequency=440:duration=1');
  if(!audioOnly)args.push('-c:v','libx264','-threads','1','-pix_fmt','yuv420p');
  args.push('-movflags','+faststart',path);execFileSync('ffmpeg',args,{timeout:10000,stdio:'pipe'});return readFileSync(path);
 }finally{rmSync(dir,{recursive:true,force:true});}
}
