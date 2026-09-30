import {createReadStream,statSync} from 'node:fs';
import {extname} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';

export function assetMime(path:string,detected?:string):string{
  if(extname(path).toLowerCase()==='.mp4'||detected==='video/mp4')return 'video/mp4';
  if(detected?.startsWith('image/'))return detected;
  return ({'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg'} as Record<string,string>)[extname(path).toLowerCase()]||'application/octet-stream';
}

export function serveAsset(req:IncomingMessage,res:ServerResponse,path:string,mime:string,revision:string,immutable:boolean):void{
  const stat=statSync(path),size=stat.size,etag=`"${revision}"`;
  const headers:Record<string,string|number>={
    'content-type':mime,'content-length':size,'cache-control':immutable?'private, max-age=31536000, immutable':'no-store',
    'etag':etag,'x-asset-revision':revision,'x-content-type-options':'nosniff'
  };
  if(mime==='video/mp4')headers['accept-ranges']='bytes';
  const range=mime==='video/mp4'&&req.headers['if-range']!==undefined&&req.headers['if-range']!==etag?undefined:req.headers.range;
  if(mime==='video/mp4'&&range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    let start=match?.[1]?Number(match[1]):0,end=match?.[2]?Number(match[2]):size-1;
    if(match&&!match[1]&&match[2]){const suffix=Number(match[2]);start=Math.max(0,size-suffix);end=size-1;}
    if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start||size===0){
      res.writeHead(416,{'content-range':`bytes */${size}`,'accept-ranges':'bytes'});res.end();return;
    }
    end=Math.min(end,size-1);
    headers['content-length']=end-start+1;headers['content-range']=`bytes ${start}-${end}/${size}`;
    res.writeHead(206,headers);
    if(req.method==='HEAD'){res.end();return;}
    createReadStream(path,{start,end}).pipe(res);return;
  }
  res.writeHead(200,headers);
  if(req.method==='HEAD'){res.end();return;}
  createReadStream(path).pipe(res);
}
