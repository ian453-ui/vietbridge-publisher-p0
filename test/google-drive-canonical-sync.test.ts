import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.ts';
import { ContentLibrary } from '../src/content-library.ts';
import { GoogleDriveCanonicalSync } from '../src/google-drive-canonical-sync.ts';

const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
function makeDocx(root:string,id:string,title:string,body:string){
  const unpacked=join(root,`src-${Math.random().toString(16).slice(2)}`),word=join(unpacked,'word');mkdirSync(join(word,'_rels'),{recursive:true});mkdirSync(join(word,'media'));
  writeFileSync(join(word,'_rels','document.xml.rels'),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');
  const values=[`content_id: ${id}`,`title: ${title}`,'series: 驻越经营实录','status: READY','publisher_status: READY','fact_check_status: PASS','visual_status: PASS','【微信公众号母稿】',`# ${title}`,body,'【头图｜COVER】','图 01｜核对内容是否对应'];
  const paragraphs=values.map((value,index)=>`<w:p><w:r><w:t>${value}</w:t>${index===10?'<w:drawing><a:blip r:embed="rId1"/></w:drawing>':''}</w:r></w:p>`).join('');
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

test('same content id with distinct Drive documents and semantic fingerprints is quarantined, not bound by scan order',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-drive-conflict-')),library=join(root,'Content-Library'),db=openDatabase(join(root,'publisher.sqlite'));
  const id='VBE-20261001-202';mkdirSync(library,{recursive:true});
  const a=makeDocx(root,id,'越南供应链流程','A版正文：供应商需要核验产能。'),b=makeDocx(root,id,'越南供应链流程修订','B版正文：供应商需要核验设备、产能与环境许可。');
  const files=[source('google-source-a',`${id}｜稿件A`,a,'2026-10-01T00:00:00.000Z'),source('google-source-b',`${id}｜稿件B`,b,'2026-10-01T00:01:00.000Z')];
  const sync=new GoogleDriveCanonicalSync(db,library,fakeDrive(files,new Map([['google-source-a',a],['google-source-b',b]])),()=>true);
  try{await sync.run('full');const row=db.prepare('SELECT disposition,COUNT(*) as count FROM drive_sync_documents GROUP BY disposition').get() as {disposition:string;count:number};assert.equal(row.disposition,'IDENTITY_CONFLICT');assert.equal(row.count,2);assert.equal(existsSync(join(library,'Drive-Canonical-Auto')),false);}
  finally{db.close();rmSync(root,{recursive:true,force:true});}
});
