import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readGptDriveInbox,approveGptDriveItem} from '../src/gpt-drive-inbox.js';
import {image as png} from './helpers/manual-sync-fixture.js';
const validImage=version=>Buffer.concat([png,Buffer.alloc(200,version)]);

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'gpt-versions-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const inbox=join(root,'GPT-INBOX');mkdirSync(inbox);
 const manifest={status:'READY',items:[]};
 function put(folder,version,caption='Draft '+version,image=validImage(version),extra={}){
  const dir=join(inbox,folder);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'primary.png'),image);
  const submission={schema_version:1,status:'READY_FOR_REVIEW',content_id:'TEST-GPT-001',revision_number:version,title:'Test only',facebook_caption:caption,primary_image:'primary.png',primary_image_sha256:createHash('sha256').update(image).digest('hex'),...extra};
  writeFileSync(join(dir,'submission.json'),JSON.stringify(submission));
  return dir;
 }
 return {root,inbox,manifest,put,read:()=>readGptDriveInbox(root,manifest,inbox)};
}

test('select highest explicit version independent of folder name; reread updated draft bytes',t=>{
 const f=fixture(t);f.put('zzz-old',1);f.put('aaa-new',2);
 assert.equal(f.read().length,1);assert.equal(f.read()[0].body,'Draft 2');
 const revision=f.read()[0].revision;
 f.put('aaa-new',2,'Edited draft');
 assert.equal(f.read()[0].body,'Edited draft');assert.notEqual(f.read()[0].revision,revision);
});
test('same-number divergent content blocks approval instead of choosing by modification time',t=>{
 const f=fixture(t);f.put('one',1);f.put('two',1,'Other text');
 const [item]=f.read();assert.equal(item.reviewStatus,'VERSION_CONFLICT');
 assert.throws(()=>approveGptDriveItem(f.root,item,f.inbox),/不能审核/);
});
test('incomplete latest image blocks stale fallback and becomes reviewable after matching bytes arrive',t=>{
 const f=fixture(t);f.put('old',1);
 f.put('new',2,'New text',validImage(2),{primary_image_sha256:'wrong'});
 assert.equal(f.read()[0].reviewStatus,'INVALID');assert.equal(f.read()[0].revisionNumber,2);
 f.put('new',2);assert.equal(f.read()[0].reviewStatus,'PENDING_REVIEW');
});
test('approved latest suppresses stale versions; newer text does not overwrite approved manifest',t=>{
 const f=fixture(t);f.put('old',1);f.put('new',2);
 f.manifest.items.push({content_id:'TEST-GPT-001',gpt_source_revision:f.read()[0].revision});
 const before=JSON.stringify(f.manifest);assert.equal(f.read().length,0);
 f.put('newest',3);assert.equal(f.read()[0].reviewStatus,'INVALID');
 assert.equal(f.read()[0].body,'Draft 3');assert.equal(JSON.stringify(f.manifest),before);
 assert.throws(()=>approveGptDriveItem(f.root,f.read()[0],f.inbox),/不能审核/);
});
test('identical duplicate folders yield one candidate and old six-field submissions remain compatible',t=>{
 const f=fixture(t);f.put('one',1,'Legacy',validImage(1),{revision_number:undefined,primary_image_sha256:undefined});
 f.put('copy',1,'Legacy');assert.equal(f.read().length,1);
 assert.equal(f.read()[0].reviewStatus,'PENDING_REVIEW');assert.equal(f.read()[0].revisionNumber,1);
});
