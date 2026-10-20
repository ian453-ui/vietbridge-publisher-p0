import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {reviewLocalContent,renderLocalQa} from '../src/content-workbench.js';
const cli=new URL('../scripts/content-workbench.mjs',import.meta.url).pathname;
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
const read=path=>JSON.parse(readFileSync(path,'utf8'));
function sandbox(fn){const dir=mkdtempSync(join(tmpdir(),'content-workbench-'));try{fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function demo(dir){const out=join(dir,'demo'),r=run('demo','--out',out);assert.equal(r.status,0,r.stderr);return out;}
test('discoverable demo reuses actual inbox update model and renders safe visual QA without approving',()=>sandbox(dir=>{
 const out=demo(dir),report=read(join(out,'review.json')),root=join(out,'synthetic-client'),manifest=join(root,'publisher-manifest.json'),before=readFileSync(manifest);
 assert.equal(report.status,'REVIEW_REQUIRED');assert.equal(report.publish_allowed,false);assert.equal(report.preview.inbox_status,'UPDATE_AVAILABLE');assert.equal(report.preview.before.content_revision,1);assert.equal(report.preview.after.content_revision,2);assert.deepEqual(report.preview.changed,{title:true,body:true,image:false});
 assert.equal(read(manifest).items[0].content_revision,1);
 const r=run('review','--request',join(out,'request.json'),'--result',join(out,'result.json'),'--root',root);assert.equal(r.status,0,r.stderr);assert.deepEqual(readFileSync(manifest),before);
 const html=readFileSync(join(out,'preview.html'),'utf8');assert.match(html,/data:image\/png;base64/);assert.match(html,/REVIEW_REQUIRED/);assert.match(html,/CONTENT|人工/);assert.ok(!html.includes('<button'));
 const hostile=structuredClone(report);hostile.preview.after.body='<script>alert(1)</script>';assert.ok(renderLocalQa(hostile).includes('&lt;script&gt;'));assert.ok(!renderLocalQa(hostile).includes('<script>'));
}));
test('plain brief/source flags export request and package explicitly provided result without hand-written JSON',()=>sandbox(dir=>{
 const brief=join(dir,'brief.txt'),source=join(dir,'reference.txt'),request=join(dir,'request.json'),caption=join(dir,'caption.txt');writeFileSync(brief,'写一则合成活动说明。');writeFileSync(source,'虚构活动在周日。');writeFileSync(caption,'虚构活动在周日，仅供测试。');
 const args=['request','--task','SYNTHETIC-001','--owner','MAC_CODEX','--workspace','synthetic','--account','account-fixture','--source','DEMO-002','--thread','1792490400.000001','--language','zh-CN','--brief-file',brief,'--source-file',source,'--source-revision','r1','--out',request];
 let r=run(...args);assert.equal(r.status,0,r.stderr);const req=read(request);assert.match(req.input.brief,/明确提供的参考正文/);assert.equal(req.input.source_refs[0].sha256.length,64);assert.equal(JSON.parse(r.stdout).sent,false);
 r=run('review','--request',request);assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).status,'WAITING_FOR_RESULT');
 const root=join(dir,'client');mkdirSync(root);mkdirSync(join(root,'GPT-INBOX'));writeFileSync(join(root,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[]}));const packet=join(root,'GPT-INBOX/result');
 r=run('package-result','--request',request,'--title','合成标题','--caption-file',caption,'--image',new URL('./fixtures/gpt-primary.png',import.meta.url).pathname,'--out',packet);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).producer_authenticated,false);
 r=run('review','--request',request,'--result',join(packet,'result.json'),'--root',root,'--out',join(dir,'qa.html'));assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'REVIEW_REQUIRED');assert.equal(read(join(root,'publisher-manifest.json')).items.length,0);
 const prior=readFileSync(request);r=run(...args);assert.equal(r.status,1);assert.match(r.stderr,/OUTPUT_ALREADY_EXISTS/);assert.deepEqual(readFileSync(request),prior);
}));
test('missing, expired and mismatched revision cases are actionable and do not write output',()=>sandbox(dir=>{
 const out=demo(dir),request=join(out,'request.json');
 let r=run('review','--request',request);assert.equal(JSON.parse(r.stdout).status,'WAITING_FOR_RESULT');
 r=run('review','--request',join(out,'expired-request.json'));assert.equal(r.status,1);assert.match(r.stderr,/RESULT_EXPIRED/);
 r=run('review','--request',request,'--result',join(out,'wrong-revision-result.json'),'--root',join(out,'synthetic-client'));assert.equal(r.status,1);assert.match(r.stderr,/RESULT_BINDING_MISMATCH/);
 const before=readFileSync(request);r=run('demo','--out',out);assert.equal(r.status,1);assert.match(r.stderr,/OUTPUT_ALREADY_EXISTS/);assert.deepEqual(readFileSync(request),before);
}));
test('fresh inbox read rejects changed base revision and changed image without adopting a new result',()=>sandbox(dir=>{
 const out=demo(dir),root=join(out,'synthetic-client'),req=read(join(out,'request.json')),result=read(join(out,'result.json'));
 writeFileSync(join(root,'READY/content/DEMO-001.md'),'# 别的标题\n\n旧版本已经改变。\n');assert.throws(()=>reviewLocalContent(req,result,root),/INBOX_VERSION_MISMATCH/);
 writeFileSync(join(root,'GPT-INBOX/result/primary.png'),Buffer.alloc(500));assert.throws(()=>reviewLocalContent(req,result,root),/INBOX_NOT_PENDING_REVIEW/);
}));
test('CLI retains original owner registry, refuses malformed JSON and never echoes error contents',()=>sandbox(dir=>{
 const out=demo(dir),file=join(dir,'bad.json');writeFileSync(file,'{"secret":"synthetic-sensitive", "secret":1}');let r=run('review','--request',file);assert.equal(r.status,1);assert.match(r.stderr,/DUPLICATE_JSON_KEY/);assert.ok(!r.stderr.includes('synthetic-sensitive'));
 r=run('request','--task','SYNTHETIC-001','--owner','CLOUD_CODEX','--workspace','synthetic','--account','fixture','--source','DEMO-003','--thread','1792490400.000001','--language','zh-CN','--brief-file',join(out,'brief.txt'),'--out',join(dir,'blocked.json'));assert.equal(r.status,1);assert.match(r.stderr,/INVALID_BRIDGE_REFERENCE/);
 r=run('review','--request',join(out,'request.json'),'--approve','true');assert.equal(r.status,1);assert.match(r.stderr,/INVALID_ARGUMENTS/);
}));
