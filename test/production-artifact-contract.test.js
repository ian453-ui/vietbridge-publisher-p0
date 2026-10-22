import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createProductionRequest,packageProductionResult,inspectProductionResult,productionItemFingerprint} from '../src/production-artifact-contract.js';
import {syntheticVideo} from './fixtures/synthetic-video.js';
const videoFixture=syntheticVideo();
const now=Date.parse('2026-10-20T12:00:00.000Z');
const spec=(artifact_id,kind,references=[],platform=null)=>({artifact_id,kind,references,platform,language:'vi+zh'});
function fixture(fn){const root=mkdtempSync(join(tmpdir(),'production-artifact-'));
 try{
  const items=['FIXTURE-003','FIXTURE-040'].map(source_id=>({source_id,content_revision:1,visual_revision:1,previous_revision:null,brief:'Synthetic knowledge brief',source_refs:[],deliverables:[spec('article','knowledge_article'),spec('cover','cover'),spec('caption','platform_payload',['article','cover'],'facebook')]}));
  items.push({source_id:'FIXTURE-VIDEO',content_revision:1,visual_revision:1,previous_revision:null,brief:'Synthetic script and video',source_refs:[],deliverables:[spec('script','script'),spec('subtitle','subtitle',['script']),spec('video','video',['script','subtitle'])]});
  const image=readFileSync(new URL('./fixtures/gpt-primary.png',import.meta.url)),selections=[];
  for(const item of items){mkdirSync(join(root,item.source_id));const files=[];for(const d of item.deliverables){const ext={article:'.md',cover:'.png',caption:'.txt',script:'.md',subtitle:'.srt',video:'.mp4'}[d.artifact_id],path=item.source_id+'/'+d.artifact_id+ext;
   const bytes=d.kind==='cover'?image:d.kind==='subtitle'?'1\n00:00:00,000 --> 00:00:01,000\n合成字幕\n':d.kind==='video'?videoFixture:'Synthetic '+item.source_id+' '+d.kind+'\n';writeFileSync(join(root,path),bytes);files.push({artifact_id:d.artifact_id,path});}selections.push({source_id:item.source_id,files});}
  const plan={schema_version:2,mode:'PRODUCTION_ARTIFACTS',task_id:'SYNTHETIC-PRODUCTION',request_revision:1,current_owner:'GPT',producer:'GPT',workspace:null,account_id:null,created_at:new Date(now-1000).toISOString(),deadline_at:new Date(now+60000).toISOString(),bridge_ref:{marker:'bridge-task:v1',protocol_version:'2.0',transport:'SLACK_FIRST',slack_channel_id:'C0C6PRGNGLQ',thread_ts:'1792490400.000001'},items};
  const request=createProductionRequest(plan),result=packageProductionResult(request,selections,{root,now});fn({root,plan,request,result,selections});
 }finally{rmSync(root,{recursive:true,force:true});}}
const inspect=f=>inspectProductionResult(f.request,f.result,{root:f.root,now});
test('two knowledge items and script/subtitle/video retain independent fingerprints and never import/publish',()=>fixture(f=>{
 const before=JSON.stringify(f),r=inspect(f);assert.equal(r.status,'REVIEW_REQUIRED');assert.equal(r.structure,'VALIDATED');assert.equal(r.scope_status,'UNKNOWN');assert.equal(r.publish_allowed,false);assert.equal(r.import_allowed,false);assert.equal(r.owner_changed,false);assert.equal(r.items.length,3);assert.notEqual(r.items[0].item_fingerprint,r.items[1].item_fingerprint);assert.equal(JSON.stringify(f),before);
 assert.equal(r.items[0].artifacts.find(a=>a.kind==='cover').validation.level,'IMAGE_DECODED');assert.equal(r.items[2].artifacts.find(a=>a.kind==='subtitle').validation.video_alignment_verified,false);
 const video=r.items[2].artifacts.find(a=>a.kind==='video');assert.equal(video.validation.level,'VIDEO_DECODED');assert.equal(video.validation.decoded,true);assert.equal(video.validation.playback_verified,false);
}));
test('missing/extra items, missing artifacts and duplicate source/artifact IDs reject',()=>fixture(f=>{
 for(const mutate of [r=>r.items.pop(),r=>r.items.push(r.items[0]),r=>r.items[0]=r.items[1],r=>r.items[0].artifacts.pop(),r=>r.items[0].artifacts[0]=r.items[0].artifacts[1]]){const result=structuredClone(f.result);mutate(result);assert.throws(()=>inspect({...f,result}));}
 const p=structuredClone(f.plan);p.items[1].source_id=p.items[0].source_id;assert.throws(()=>createProductionRequest(p),/DUPLICATE_SOURCE/);
}));
test('wrong owner/thread/account/request and mixed item versions/fingerprints reject before review',()=>fixture(f=>{
 for(const mutate of [r=>r.current_owner='MAC_CODEX',r=>r.account_id='other',r=>r.request_revision++,r=>r.bridge_ref.thread_ts='1792490400.000002',r=>r.items[0].content_revision++,r=>r.items[0].visual_revision++,r=>r.items[0].previous_revision='a'.repeat(64),r=>r.items[0].item_fingerprint=r.items[1].item_fingerprint]){const result=structuredClone(f.result);mutate(result);assert.throws(()=>inspect({...f,result}));}
}));
test('actual file hash, caption reference hash and reused source files cannot silently mix',()=>fixture(f=>{
 const r=structuredClone(f.result);r.items[0].artifacts[0].sha256='a'.repeat(64);assert.throws(()=>inspect({...f,result:r}),/ARTIFACT_HASH_MISMATCH|RESULT_REFERENCE_MISMATCH/);
 const reference=structuredClone(f.result);reference.items[0].artifacts[2].references[0].sha256=f.result.items[1].artifacts[0].sha256;assert.throws(()=>inspect({...f,result:reference}),/RESULT_REFERENCE_MISMATCH/);
 const reused=structuredClone(f.result);reused.items[1].artifacts[1].path=reused.items[0].artifacts[1].path;assert.throws(()=>inspect({...f,result:reused}),/ARTIFACT_FILE_REUSED/);
 writeFileSync(join(f.root,f.result.items[0].artifacts[0].path),'changed');assert.throws(()=>inspect(f),/ARTIFACT_HASH_MISMATCH/);
}));
test('traversal and escaping symlinks reject without reading external artifacts',()=>fixture(f=>{
 for(const path of ['../outside.md','/etc/passwd','a/../../secret','a\\b']){const r=structuredClone(f.result);r.items[0].artifacts[0].path=path;assert.throws(()=>inspect({...f,result:r}),/INVALID_ARTIFACT_PATH/);}
 symlinkSync('/etc/passwd',join(f.root,'escape.md'));const r=structuredClone(f.result);r.items[0].artifacts[0].path='escape.md';assert.throws(()=>inspect({...f,result:r}),/ARTIFACT_PATH_ESCAPE/);
}));
test('corrupt images, malformed UTF8 and malformed/reversed SRT are rejected at packaging',()=>fixture(f=>{
 const png=join(f.root,'FIXTURE-003/cover.png'),original=readFileSync(png);writeFileSync(png,Buffer.alloc(100));assert.throws(()=>packageProductionResult(f.request,f.selections,{root:f.root,now}),/IMAGE_/);writeFileSync(png,original);
 const article=join(f.root,'FIXTURE-003/article.md');writeFileSync(article,Buffer.from([255,254]));assert.throws(()=>packageProductionResult(f.request,f.selections,{root:f.root,now}),/INVALID_UTF_EIGHT/);writeFileSync(article,'Synthetic restored');
 const srt=join(f.root,'FIXTURE-VIDEO/subtitle.srt');for(const value of ['junk','1\n00:00:02,000 --> 00:00:01,000\nx','2\n00:00:00,000 --> 00:00:01,000\nx']){writeFileSync(srt,value);assert.throws(()=>packageProductionResult(f.request,f.selections,{root:f.root,now}),/INVALID_SUBTITLE/);}
}));
test('duplicate receipt is inert, conflict rejects and stale/future results never grant review',()=>fixture(f=>{
 const first=inspect(f),receipt=first.receipt;assert.equal(inspectProductionResult(f.request,f.result,{root:f.root,now:now+120000,priorReceipt:receipt}).status,'DUPLICATE');
 assert.throws(()=>inspectProductionResult(f.request,f.result,{root:f.root,now:now+120000}),/RESULT_EXPIRED/);
 const r=structuredClone(f.result);r.completed_at=new Date(now-1).toISOString();assert.throws(()=>inspectProductionResult(f.request,r,{root:f.root,now,priorReceipt:receipt}),/CONFLICTING_RESULT/);
 r.completed_at=new Date(now+1).toISOString();assert.throws(()=>inspect({...f,result:r}),/INVALID_RESULT_TIME/);
}));
test('item evolution preserves prior source identities and independently versioned content',()=>fixture(f=>{
 const p=structuredClone(f.plan);p.request_revision++;p.items[0].content_revision++;p.items[0].brief+=' revised';p.items[0].previous_revision=productionItemFingerprint(f.plan.items[0]);
 const r=createProductionRequest(p,{priorRequest:f.request});assert.equal(r.items[1].content_revision,1);assert.equal(r.items[0].content_revision,2);
 p.current_owner='MAC_CODEX';assert.throws(()=>createProductionRequest(p,{priorRequest:f.request}),/REQUEST_IDENTITY_CHANGE/);p.current_owner='GPT';
 p.items[0].source_id='FIXTURE-REPLACED';assert.throws(()=>createProductionRequest(p,{priorRequest:f.request}),/ITEM_REMOVAL/);p.items[0].source_id='FIXTURE-003';p.items[0].previous_revision=null;assert.throws(()=>createProductionRequest(p,{priorRequest:f.request}),/ITEM_REVISION_CONFLICT/);
 const reordered=Object.fromEntries(Object.entries(f.plan).reverse());assert.equal(createProductionRequest(reordered).request_fingerprint,f.request.request_fingerprint);
}));
test('CLI production modes reuse strict JSON and refuse overwrites',()=>fixture(f=>{
 const cli=new URL('../scripts/content-workbench.mjs',import.meta.url).pathname,plan=join(f.root,'plan.json'),req=join(f.root,'request.json'),sel=join(f.root,'selections.json'),result=join(f.root,'result.json');
 const at=Date.now();f.plan.created_at=new Date(at-1000).toISOString();f.plan.deadline_at=new Date(at+60000).toISOString();writeFileSync(plan,JSON.stringify(f.plan));writeFileSync(sel,JSON.stringify(f.selections));const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
 for(const args of [['production-request','--plan',plan,'--out',req],['production-package','--request',req,'--selections',sel,'--root',f.root,'--out',result],['production-review','--request',req,'--result',result,'--root',f.root]]){const r=run(...args);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).publish_allowed,false);}
 assert.match(run('production-request','--plan',plan,'--out',req).stderr,/OUTPUT_ALREADY_EXISTS/);
 writeFileSync(plan,'{"items":[],"items":[],"secret":"not-for-echo"}');const bad=run('production-request','--plan',plan,'--out',join(f.root,'bad.json'));assert.equal(bad.status,1);assert.match(bad.stderr,/DUPLICATE_JSON_KEY/);assert.ok(!bad.stderr.includes('not-for-echo'));
}));

test('root-local ..notes.md is legal, while a symlink to a parent directory remains blocked',()=>fixture(f=>{
 const original=f.selections[0].files[0].path;renameSync(join(f.root,original),join(f.root,'..notes.md'));f.selections[0].files[0].path='..notes.md';
 const result=packageProductionResult(f.request,f.selections,{root:f.root,now});assert.equal(inspect({...f,result}).status,'REVIEW_REQUIRED');
 symlinkSync(tmpdir(),join(f.root,'outside-directory'));result.items[0].artifacts[0].path='outside-directory';assert.throws(()=>inspect({...f,result}),/ARTIFACT_PATH_ESCAPE/);
}));
test('independent same-byte files pass, but hardlinks across items are not independent artifacts',()=>fixture(f=>{
 assert.equal(inspect(f).status,'REVIEW_REQUIRED');
 const first=join(f.root,f.result.items[0].artifacts[1].path),second=join(f.root,f.result.items[1].artifacts[1].path);
 symlinkSync(first,join(f.root,'alias.png'));
 const aliased=structuredClone(f.result);aliased.items[1].artifacts[1].path='alias.png';
 assert.throws(()=>inspect({...f,result:aliased}),/ARTIFACT_FILE_REUSED/);
 rmSync(second);linkSync(first,second);
 assert.throws(()=>inspect(f),/ARTIFACT_FILE_REUSED/);
 assert.throws(()=>packageProductionResult(f.request,f.selections,{root:f.root,now}),/ARTIFACT_FILE_REUSED/);
}));
test('descriptor identity checks reject a FIFO without waiting for a writer',()=>fixture(f=>{
 const pipe=join(f.root,'pipe.md');const made=spawnSync('mkfifo',[pipe],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
 const cli=new URL('../scripts/content-workbench.mjs',import.meta.url).pathname;
 const at=Date.now();f.plan.created_at=new Date(at-1000).toISOString();f.plan.deadline_at=new Date(at+60000).toISOString();
 const request=createProductionRequest(f.plan);f.selections[0].files[0].path='pipe.md';
 writeFileSync(join(f.root,'request.json'),JSON.stringify(request));writeFileSync(join(f.root,'files.json'),JSON.stringify(f.selections));
 const r=spawnSync(process.execPath,[cli,'production-package','--request',join(f.root,'request.json'),'--selections',join(f.root,'files.json'),'--root',f.root,'--out',join(f.root,'out.json')],{encoding:'utf8',timeout:5000});
 assert.equal(r.error,undefined);assert.equal(r.status,1);assert.match(r.stderr,/INVALID_ARTIFACT_SIZE/);
}));

test('original fake MP4 is rejected by production packaging, not admitted as reviewable video',()=>fixture(f=>{
 writeFileSync(join(f.root,'FIXTURE-VIDEO/video.mp4'),'Deliberately NOT a playable video: tests bytes-only boundary.');
 assert.throws(()=>packageProductionResult(f.request,f.selections,{root:f.root,now}),/VIDEO_/);
}));
