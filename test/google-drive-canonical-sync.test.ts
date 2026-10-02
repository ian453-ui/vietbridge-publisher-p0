import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.ts';
import { ContentLibrary } from '../src/content-library.ts';
import { GoogleDriveCanonicalSync } from '../src/google-drive-canonical-sync.ts';

const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
function makeDocx(root:string,id:string,title:string,body:string,status='READY',withPublicSection=true){
  const unpacked=join(root,`src-${Math.random().toString(16).slice(2)}`),word=join(unpacked,'word');mkdirSync(join(word,'_rels'),{recursive:true});mkdirSync(join(word,'media'));
  writeFileSync(join(word,'_rels','document.xml.rels'),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');
  const values=[`content_id: ${id}`,`title: ${title}`,'series: 驻越经营实录',`status: ${status}`,'publisher_status: READY','fact_check_status: PASS','visual_status: PASS',...(withPublicSection?['【微信公众号母稿】']:[]),`# ${title}`,body,'【头图｜COVER】','图 01｜核对内容是否对应'];
  const paragraphs=values.map((value,index)=>`<w:p><w:r><w:t>${value}</w:t>${index===values.length-2?'<w:drawing><a:blip r:embed="rId1"/></w:drawing>':''}</w:r></w:p>`).join('');
  writeFileSync(join(word,'document.xml'),`<w:document>${paragraphs}</w:document>`);writeFileSync(join(word,'media','image1.png'),png);
  const path=join(root,`${id}.docx`);execFileSync('zip',['-q','-r',path,'word'],{cwd:unpacked});return readFileSync(path);
}
function source(id:string,name:string,bytes:Buffer,modifiedTime='2026-10-01T00:00:00.000Z'){return {id,name,mimeType:'application/vnd.google-apps.document',modifiedTime,webViewLink:`https://docs.google.com/document/d/${id}/edit`};}
function fakeDrive(files:Array<ReturnType<typeof source>>,bytes:Map<string,Buffer>){return {
  async listCanonicalDocs(){return files;},async startPageToken(){return 'token-0';},async changes(){return {changes:[],newStartPageToken:'token-1'};},
  async exportDocx(id:string){const item=bytes.get(id);if(!item)throw new Error('MISSING_FIXTURE');return item;}
};}

test('full scan materializes current text plus inline image, then same Drive identity updates the same Publisher item',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-auto-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));
  const id='VBE-20261001-201',docId='google-source-document-201';mkdirSync(library,{recursive:true});
  const oldBytes=makeDocx(root,id,'工厂成本先核算','正文旧版：按单位成本复核越南工厂。');
  const driveFile=source(docId,`${id}｜驻越经营实录` ,oldBytes),bytes=new Map([[docId,oldBytes]]);
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive([driveFile],bytes),()=>true);
  try{
    await sync.run('full');
    const first=new ContentLibrary({roots:[library]}).index();assert.equal(first.length,1);assert.equal(first[0].articleId,id);assert.equal(first[0].canonicalDocument.driveFileId,docId);
    assert.match(readFileSync(first[0].payloads.wechat_official_account!,'utf8'),/正文旧版/);assert.equal(first[0].assets.length,1);assert.equal(first[0].readiness,'BLOCKED');assert.ok(first[0].blockingReasons.includes('FACT_QA_PENDING'));assert.ok(first[0].blockingReasons.includes('VISUAL_QA_PENDING'));
    const packageRoot=first[0].packageRoot,updatedBytes=makeDocx(root,id,'工厂成本先核算','正文新版：将同一单位成本口径写入采购与预算复核。');bytes.set(docId,updatedBytes);driveFile.modifiedTime='2026-10-01T00:10:00.000Z';
    await sync.run('full');const current=new ContentLibrary({roots:[library]}).index();assert.equal(current.length,1);assert.equal(current[0].packageRoot,packageRoot);assert.equal(current[0].duplicateCandidates,0);assert.match(readFileSync(current[0].payloads.wechat_official_account!,'utf8'),/正文新版/);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('a pending canonical revision refreshes visible text while keeping publication blocked',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-pending-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));
  const id='VBE-20261001-204',docId='google-source-document-204';mkdirSync(library,{recursive:true});
  const oldBytes=makeDocx(root,id,'待校稿文章','旧文字需要替换');
  const file=source(docId,`${id}｜驻越经营实录`,oldBytes),bytes=new Map([[docId,oldBytes]]);
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive([file],bytes),()=>true);
  try{
    await sync.run('full');
    bytes.set(docId,makeDocx(root,id,'待校稿文章','GPT 新文字已经可读','CONTENT_QA_PENDING'));file.modifiedTime='2026-10-01T00:20:00.000Z';
    await sync.run('full');
    const item=new ContentLibrary({roots:[library]}).index()[0];
    assert.match(readFileSync(item.payloads.wechat_official_account!,'utf8'),/GPT 新文字已经可读/);
    assert.doesNotMatch(readFileSync(item.payloads.wechat_official_account!,'utf8'),/旧文字需要替换/);
    assert.equal(item.readiness,'BLOCKED');assert.ok(item.blockingReasons.includes('SOURCE_QA_PENDING'));
    assert.equal((db.prepare('SELECT disposition FROM drive_sync_documents WHERE drive_file_id=? AND content_id=?').get(docId,id) as {disposition:string}).disposition,'SOURCE_QA_PENDING');
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('producer QA pass is distinct from Publisher fact and visual review',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-producer-pass-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));mkdirSync(library,{recursive:true});
  const id='VBE-20261001-205',docId='google-source-document-205',bytes=makeDocx(root,id,'经营许可复核','可预览的公开稿','CONTENT_VISUAL_QA_PASS');
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive([source(docId,`${id}｜驻越经营实录`,bytes)],new Map([[docId,bytes]])),()=>true);
  try{await sync.run('full');const item=new ContentLibrary({roots:[library]}).index()[0];assert.ok(!item.blockingReasons.includes('SOURCE_QA_PENDING'));assert.ok(item.blockingReasons.includes('FACT_QA_PENDING'));assert.ok(item.blockingReasons.includes('VISUAL_QA_PENDING'));assert.equal((db.prepare('SELECT disposition FROM drive_sync_documents WHERE content_id=?').get(id) as {disposition:string}).disposition,'IMPORTED');}
  finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('an unsegmented GPT draft stays readable as Drive source but cannot replace public copy',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-draft-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));mkdirSync(library,{recursive:true});
  const id='VBE-20261001-206',docId='google-source-document-206',bytes=makeDocx(root,id,'未分段母稿','GPT 写出的完整正文','READY',false);
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive([source(docId,`${id}｜驻越经营实录`,bytes)],new Map([[docId,bytes]])),()=>true);
  try{await sync.run('full');assert.equal((db.prepare('SELECT disposition FROM drive_sync_documents WHERE content_id=?').get(id) as {disposition:string}).disposition,'SOURCE_PUBLIC_COPY_MISSING');assert.equal(new ContentLibrary({roots:[library]}).index().length,0);const review=await sync.previewSource(id,docId);assert.match(review.paragraphs.join(' '),/GPT 写出的完整正文/);assert.equal(review.fields.status,'READY');assert.equal(review.publicSections.wechat,false);assert.equal(review.images.length,1);}
  finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('a reviewed new single Doc can manually replace an older aggregate source without approving publication',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-rebind-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));mkdirSync(library,{recursive:true});
  const id='VBE-20261001-207',oldDoc='aggregate-source-207',newDoc='single-source-document-207';
  const oldBytes=makeDocx(root,id,'同一案例','旧公开正文'),newBytes=makeDocx(root,id,'同一案例','GPT 新公开正文');
  const files=[source(oldDoc,`${id}｜聚合稿`,oldBytes)],bytes=new Map([[oldDoc,oldBytes],[newDoc,newBytes]]);
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive(files,bytes),()=>true);
  try{
    await sync.run('full');const oldPackage=new ContentLibrary({roots:[library]}).index()[0];assert.equal(oldPackage.packageRoot,realpathSync(join(library,'Drive-Canonical-Auto',id)));
    files.splice(0,1,source(newDoc,`${id}｜单篇稿`,newBytes,'2026-10-01T00:30:00.000Z'));
    await sync.run('full');assert.equal((db.prepare('SELECT disposition FROM drive_sync_documents WHERE drive_file_id=?').get(newDoc) as {disposition:string}).disposition,'IDENTITY_CONFLICT');
    assert.throws(()=>sync.approveRebind(id,newDoc,oldPackage.packageRoot,false),/EXPLICIT_REBIND_CONFIRMATION_REQUIRED/);
    const accepted=sync.approveRebind(id,newDoc,oldPackage.packageRoot,true);assert.equal(accepted.publicationAuthorized,false);
    await sync.run('auto');const current=new ContentLibrary({roots:[library]}).index()[0];
    assert.equal(current.canonicalDocument.driveFileId,newDoc);assert.match(readFileSync(current.payloads.wechat_official_account!,'utf8'),/GPT 新公开正文/);
    assert.equal(current.readiness,'BLOCKED');assert.ok(current.blockingReasons.includes('FACT_QA_PENDING'));
    const manifest=JSON.parse(readFileSync(join(current.packageRoot,'manifest.json'),'utf8'));assert.equal(manifest.drive_rebind_from,oldDoc);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('full scan skips large aggregate Docs unless they are already tracked',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-aggregate-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));
  const id='VBE-20261001-203',docId='google-source-document-203';mkdirSync(library,{recursive:true});
  const bytes=makeDocx(root,id,'单篇规范文章','正文：只导入有单篇内容编号的规范文章。');
  const files=[source(docId,`${id}｜驻越经营实录`,bytes),source('large-review-bundle','2026-09-28 驻越经营实录 091-101 大众商业案例 待QA',bytes),source('large-archive-bundle','2026-09-16｜驻越经营实录｜新增20篇生产包（22-41）',bytes)];
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive(files,new Map([[docId,bytes]])),()=>true);
  try{
    await sync.run('full');
    assert.equal(sync.status().lastError,'');
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM drive_sync_documents WHERE active=1').get()?.count,1);
    assert.equal(new ContentLibrary({roots:[library]}).index()[0].articleId,id);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('a manual full scan queues behind an active automatic changes scan',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-manual-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));mkdirSync(library,{recursive:true});
  let fullScans=0;const drive={async listCanonicalDocs(){fullScans++;return [];},async startPageToken(){return 'token-0';},async changes(){await new Promise(resolve=>setTimeout(resolve,40));return {changes:[],newStartPageToken:'token-1'};},async exportDocx(){throw new Error('UNEXPECTED_EXPORT');}};
  const sync=new GoogleDriveCanonicalSync(db,library,drive,()=>true);
  try{
    await sync.run('full');assert.equal(fullScans,1);
    const automatic=sync.run('auto');await new Promise(resolve=>setTimeout(resolve,5));const manual=sync.run('full');
    await Promise.all([automatic,manual]);assert.equal(fullScans,2);assert.equal(sync.status().lastError,'');
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('a manual request joins an automatic full scan instead of exporting twice',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-join-full-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));mkdirSync(library,{recursive:true});
  let fullScans=0;const drive={async listCanonicalDocs(){fullScans++;await new Promise(resolve=>setTimeout(resolve,40));return [];},async startPageToken(){return 'token-0';},async changes(){return {changes:[],newStartPageToken:'token-1'};},async exportDocx(){throw new Error('UNEXPECTED_EXPORT');}};
  const sync=new GoogleDriveCanonicalSync(db,library,drive,()=>true);
  try{
    const automatic=sync.run('auto'),manual=sync.run('full');
    assert.equal(sync.status().runningFull,true);
    assert.equal(sync.status().queuedFull,false);
    await Promise.all([automatic,manual]);
    assert.equal(fullScans,1);
    assert.ok(sync.status().lastFullCompletedAt);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('an automatic change check stops at the new start token',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-cursor-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));mkdirSync(library,{recursive:true});
  let calls=0;const drive={async listCanonicalDocs(){return [];},async startPageToken(){return 'token-0';},async changes(){calls++;return {changes:[],newStartPageToken:'token-1'};},async exportDocx(){throw new Error('UNEXPECTED_EXPORT');}};
  const sync=new GoogleDriveCanonicalSync(db,library,drive,()=>true);
  try{await sync.run('full');await sync.run('auto');assert.equal(calls,1);}
  finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('same content id with distinct Drive documents and semantic fingerprints is quarantined, not bound by scan order',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-conflict-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));
  const id='VBE-20261001-202';mkdirSync(library,{recursive:true});
  const a=makeDocx(root,id,'越南供应链流程','A版正文：供应商需要核验产能。'),b=makeDocx(root,id,'越南供应链流程修订','B版正文：供应商需要核验设备、产能与环境许可。');
  const files=[source('google-source-a',`${id}｜稿件A`,a,'2026-10-01T00:00:00.000Z'),source('google-source-b',`${id}｜稿件B`,b,'2026-10-01T00:01:00.000Z')];
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive(files,new Map([['google-source-a',a],['google-source-b',b]])),()=>true);
  try{await sync.run('full');const row=db.prepare('SELECT disposition,COUNT(*) as count FROM drive_sync_documents GROUP BY disposition').get() as {disposition:string;count:number};assert.equal(row.disposition,'IDENTITY_CONFLICT');assert.equal(row.count,2);assert.equal(existsSync(join(library,'Drive-Canonical-Auto')),false);}
  finally{db.close();rmSync(root,{recursive:true,force:true});}
});
