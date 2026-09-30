import test from 'node:test';
import assert from 'node:assert/strict';
import {FacebookVideo,verifiedFacebookVideo,parseSystemHttpsProxy,facebookUserTokenCandidates} from '../src/facebook-video.ts';
import {facebookVideoAbsenceIsConclusive,findFacebookVideoCandidates,facebookVideoProcessingReadbackError} from '../src/platform-worker.ts';
test('newly accepted Facebook video may temporarily lack a detail object',()=>{
 assert.equal(facebookVideoProcessingReadbackError(new Error('Facebook 接口错误 HTTP 400 code 100 subcode 33')),true);
 assert.equal(facebookVideoProcessingReadbackError(new Error('Facebook 接口错误 HTTP 401 code 190 subcode 467')),false);
});
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('Facebook video prefers refreshed private token only for the same Page',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fb-video-cache-')),file=join(dir,'token.json');
 try{
  writeFileSync(file,JSON.stringify({token:'fresh',pageId:'123'}),{mode:0o600});
  assert.deepEqual(facebookUserTokenCandidates({FB_USER_ACCESS_TOKEN:'stale'},file,'123'),['fresh','stale']);
  assert.deepEqual(facebookUserTokenCandidates({FB_USER_ACCESS_TOKEN:'stale'},file,'456'),['stale']);
  chmodSync(file,0o644);
  assert.deepEqual(facebookUserTokenCandidates({FB_USER_ACCESS_TOKEN:'stale'},file,'123'),['stale']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Facebook video uses the enabled macOS HTTPS proxy',()=>{
 assert.deepEqual(parseSystemHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'),{protocol:'http',host:'127.0.0.1',port:7897});
 assert.equal(parseSystemHttpsProxy('HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'),false);
});
test('Facebook video requires matching account, content, ready status and published flag',()=>{
 const good={id:'1',from:{id:'2'},title:'t',description:'d',published:true,status:{video_status:'ready'},permalink_url:'https://www.facebook.com/watch/?v=1'};
 assert.equal(verifiedFacebookVideo(good,'1','2','t','d'),true);
 for(const patch of [{id:'3'},{from:{id:'3'}},{title:'wrong'},{description:'wrong'},{published:false},{status:{video_status:'processing'}},{permalink_url:'https://example.com'}]) assert.equal(verifiedFacebookVideo({...good,...patch},'1','2','t','d'),false);
});
test('Facebook video reconciliation requires one exact title and description',()=>{
 const list={data:[{id:'1',title:'标题',description:'正文\n'},{id:'2',title:'其他',description:'正文'}]};
 assert.deepEqual(findFacebookVideoCandidates(list,'标题','正文'),['1']);
 assert.deepEqual(findFacebookVideoCandidates({data:[...list.data,{id:'3',title:'标题',description:'正文'}]},'标题','正文'),['1','3']);
});
test('Facebook video absence is conclusive only for a complete list after processing delay',()=>{
 const submitted='2026-09-16T12:00:00.000Z',later=Date.parse('2026-09-16T13:01:00.000Z');
 assert.equal(facebookVideoAbsenceIsConclusive({data:[],paging:{}},submitted,later),true);
 assert.equal(facebookVideoAbsenceIsConclusive({data:[],paging:{next:'next-page'}},submitted,later),false);
 assert.equal(facebookVideoAbsenceIsConclusive({data:[],paging:{}},submitted,Date.parse('2026-09-16T12:30:00.000Z')),false);
});
test('Facebook read errors redact sensitive response text and never retry',async()=>{
 let calls=0;
 const api=new FacebookVideo((async()=>{calls++;return new Response(JSON.stringify({error:{message:'SECRET',code:190}}),{status:400});}) as typeof fetch);
 await assert.rejects(api.get('1'),error=>!String(error).includes('SECRET')&&String(error).includes('190'));
 assert.equal(calls,1);
 await assert.rejects(api.get('../me'));assert.equal(calls,1);
});
