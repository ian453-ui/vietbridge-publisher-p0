import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPublisherServer} from '../src/web-server.ts';

test('video preview keeps MP4 separate, streams byte ranges, and reports missing video',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-video-preview-'));
  const content=join(root,'VIDEO-068-CHAGEE'),manifest=join(content,'manifest'),final=join(content,'final'),covers=join(content,'covers');
  for(const path of [content,manifest,final,covers])mkdirSync(path,{recursive:true});
  const videoPath=join(final,'VIDEO-068-CHAGEE-final.mp4');
  const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisom'),Buffer.alloc(240,7)]);
  writeFileSync(videoPath,bytes);
  writeFileSync(join(covers,'VIDEO-068-CHAGEE-cover.png'),Buffer.from([137,80,78,71,13,10,26,10,1]));
  writeFileSync(join(manifest,'VIDEO-068-CHAGEE.json'),JSON.stringify({item_id:'VIDEO-068-CHAGEE',status:'QA_PASSED',video:'../final/VIDEO-068-CHAGEE-final.mp4',cover:'../covers/VIDEO-068-CHAGEE-cover.png'}));
  writeFileSync(join(content,'VIDEO-068-CHAGEE-xiaohongshu-video-public.txt'),'测试视频标题\n测试正文');
  const server=createPublisherServer({dbPath:join(root,'publisher.sqlite'),contentRoots:[content],stagingRoot:join(root,'staging'),mirrorPath:join(root,'events.jsonl'),workerEnabled:false});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  try{
    const page=await (await fetch(base)).text();
    assert.match(page,/<video controls preload="metadata" playsinline/);
    assert.match(page,/缺少视频文件，当前仅有封面/);
    const candidates=await (await fetch(`${base}/api/content/candidates?includePublished=1&includeIncomplete=1`)).json() as any;
    const item=candidates.candidates.find((x:any)=>x.articleId==='VIDEO-068-CHAGEE');assert.ok(item);
    assert.equal(item.assets.filter((a:any)=>a.role==='video').length,1);
    const preview=await (await fetch(`${base}/api/content/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({articleId:item.articleId,packageRoot:item.packageRoot,version:item.version})})).json() as any;
    assert.equal(preview.videos.length,1);
    assert.equal(preview.assets.filter((a:any)=>a.role==='video').length,0);
    const url=new URL('/api/content/asset',base);url.searchParams.set('path',item.assets.find((a:any)=>a.role==='video').path);url.searchParams.set('revision',item.assets.find((a:any)=>a.role==='video').revision);
    const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200,`asset response ${head.status}: ${url.pathname}`);assert.equal(head.headers.get('content-type'),'video/mp4');assert.equal(head.headers.get('accept-ranges'),'bytes');
    const first=await fetch(url,{headers:{Range:'bytes=0-19'}});assert.equal(first.status,206);assert.equal(first.headers.get('content-range'),`bytes 0-19/${bytes.length}`);assert.deepEqual(Buffer.from(await first.arrayBuffer()),bytes.subarray(0,20));
    const seek=await fetch(url,{headers:{Range:'bytes=100-149'}});assert.equal(seek.status,206);assert.deepEqual(Buffer.from(await seek.arrayBuffer()),bytes.subarray(100,150));
    const invalid=await fetch(url,{headers:{Range:`bytes=${bytes.length}-`}});assert.equal(invalid.status,416);
    const taskResponse=await fetch(`${base}/api/tasks/execute`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'article_id',value:item.articleId,platforms:['xiaohongshu']})});
    assert.equal(taskResponse.status,201,await taskResponse.clone().text());
    const task=await taskResponse.json() as any,jobId=task.jobs[0].job_id;
    const frozen=await (await fetch(`${base}/api/jobs/${jobId}/preview`)).json() as any;
    assert.equal(frozen.videos.length,1);
    assert.equal(frozen.assets.filter((a:any)=>a.mime_detected==='video/mp4').length,0);
    const frozenVideo=await fetch(`${base}/api/jobs/${jobId}/assets/${frozen.videos[0].asset_id}`,{headers:{Range:'bytes=50-99'}});
    assert.equal(frozenVideo.status,206);
    assert.equal(frozenVideo.headers.get('content-type'),'video/mp4');
    assert.deepEqual(Buffer.from(await frozenVideo.arrayBuffer()),bytes.subarray(50,100));
    rmSync(frozen.videos[0].staging_path);
    const frozenMissing=await (await fetch(`${base}/api/jobs/${jobId}/preview`)).json() as any;
    assert.deepEqual(frozenMissing.videos,[]);
    assert.equal(frozenMissing.contentType,'video');
    rmSync(videoPath);
    const missing=await (await fetch(`${base}/api/content/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({articleId:item.articleId})})).json() as any;
    assert.deepEqual(missing.videos,[]);
    assert.equal(missing.articleId,'VIDEO-068-CHAGEE');
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    rmSync(root,{recursive:true,force:true});
  }
});
