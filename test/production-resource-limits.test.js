import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,truncateSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validateVideo} from '../src/video-validation.js';
import {readProductionArtifacts} from '../src/production-artifact-contract.js';
import {ProductionReviewStore} from '../src/production-review-store.js';
import {syntheticVideo} from './fixtures/synthetic-video.js';
import {v3ReviewDemo} from '../scripts/v3-review-demo.mjs';
function temporary(t){const root=mkdtempSync(join(tmpdir(),'v3-budget-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function executable(root,name,code){const path=join(root,name);writeFileSync(path,'#!'+process.execPath+'\n'+code,{mode:0o700});return path;}

test('decoder hard timeout kills a SIGTERM-ignoring process; output overflow and abnormal exit fail',t=>{
 const root=temporary(t),bytes=syntheticVideo(),marker=join(root,'pid');
 const hung=executable(root,'hung',`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
 const start=Date.now();assert.throws(()=>validateVideo(bytes,'.mp4',{ffprobe:hung,probeTimeoutMs:200}),/VIDEO_VALIDATION_RESOURCE_LIMIT/);assert.ok(Date.now()-start<2000);
 if(existsSync(marker))assert.throws(()=>process.kill(Number(readFileSync(marker)),0),/ESRCH/);
 const overflow=executable(root,'overflow',"process.stdout.write('x'.repeat(500000));");assert.throws(()=>validateVideo(bytes,'.mp4',{ffprobe:overflow,maxBuffer:1024}),/RESOURCE_LIMIT/);
 const broken=executable(root,'broken','process.exit(2);');assert.throws(()=>validateVideo(bytes,'.mp4',{ffmpeg:broken}),/VIDEO_DECODE_INVALID/);
});
test('whole-batch byte/count/video budgets reject before any external tool is invoked',t=>{
 const root=temporary(t),marker=join(root,'invoked');executable(root,'ffprobe',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'invoked');process.exit(1);`);
 for(const name of ['one.mp4','two.mp4']){writeFileSync(join(root,name),'');truncateSync(join(root,name),70*1024*1024);}
 const before=process.env.PATH;process.env.PATH=root;
 try{
  assert.throws(()=>readProductionArtifacts(root,[{path:'one.mp4',kind:'video'},{path:'two.mp4',kind:'video'}]),/ARTIFACT_BATCH_SIZE_LIMIT/);
  assert.throws(()=>readProductionArtifacts(root,Array.from({length:101},()=>({path:'missing.md',kind:'script'}))),/COUNT_LIMIT/);
  assert.throws(()=>readProductionArtifacts(root,Array.from({length:9},()=>({path:'missing.mp4',kind:'video'}))),/COUNT_LIMIT/);
  assert.equal(existsSync(marker),false);
 }finally{process.env.PATH=before;}
});
test('batch elapsed budget is propagated into video subprocess timeout',t=>{
 const root=temporary(t);writeFileSync(join(root,'sample.mp4'),syntheticVideo());
 assert.throws(()=>readProductionArtifacts(root,[{path:'sample.mp4',kind:'video'}],{wallMs:1}),/TIME_LIMIT|RESOURCE_LIMIT/);
});
test('review intake persists the same validated snapshots with exactly one probe/decode per video',t=>{
 const root=temporary(t),out=join(root,'demo'),demo=v3ReviewDemo(out),db=new DatabaseSync(demo.dbPath);t.after(()=>db.close());
 const count=join(root,'calls'),bin=join(root,'bin');mkdirSync(bin);
 for(const name of ['ffprobe','ffmpeg'])executable(bin,name,`require('node:fs').appendFileSync(${JSON.stringify(count)},'${name}\\n');const p=require('node:child_process').spawnSync('/usr/bin/${name}',process.argv.slice(2),{encoding:'utf8'});process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');process.exit(p.status??1);`);
 const before=process.env.PATH;process.env.PATH=bin+':'+before;
 try{new ProductionReviewStore(db).ingest(JSON.parse(readFileSync(join(out,'request.json'))),JSON.parse(readFileSync(join(out,'result.json'))),{root:demo.artifactRoot});}
 finally{process.env.PATH=before;}
 assert.deepEqual(readFileSync(count,'utf8').trim().split('\n'),['ffprobe','ffmpeg']);
});
