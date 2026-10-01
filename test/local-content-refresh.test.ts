import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalContentRefresher } from '../src/local-content-refresh.ts';
import { ContentLibrary } from '../src/content-library.ts';
import { ingestDocxContentBundle } from '../src/docx-content-ingestor.ts';

test('manual image refresh requires exact active filename, image bytes and QA confirmation',()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-image-refresh-'));
  const id='VBE-20260923-072',name='cover_QA_PASS.png',dir=join(root,id);
  mkdirSync(dir);const png=Buffer.from([137,80,78,71,13,10,26,10,2]);
  writeFileSync(join(dir,name),Buffer.from([137,80,78,71,13,10,26,10,1]));
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({article_id:id,canonical_source:'independent_rewrite_doc',active_assets:[name],asset_sources:{[name]:{role:'COVER',drive_file_id:'1Yi0MNkAl_P0GFHmciDeuXWiRbmim3dCR'}}}));
  const refresh=new LocalContentRefresher(root);
  try{
    assert.throws(()=>refresh.refreshImage(id,name,png,false),/IMAGE_QA_CONFIRMATION_REQUIRED/);
    assert.throws(()=>refresh.refreshImage(id,'other.png',png,true),/ACTIVE_IMAGE_NOT_FOUND/);
    assert.throws(()=>refresh.refreshImage(id,name,Buffer.from('not an image'),true),/IMAGE_FORMAT_MISMATCH/);
    const result=refresh.refreshImage(id,name,png,true);
    assert.equal(result.changed,true);
    assert.deepEqual(readFileSync(join(dir,name)),png);
    assert.equal(refresh.refreshImage(id,name,png,true).changed,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('manual DOCX refresh updates article and image while preserving identity and not creating a publication task', () => {
  const root=mkdtempSync(join(tmpdir(),'publisher-manual-refresh-'));
  const unpacked=join(root,'unpacked'),word=join(unpacked,'word'),content=join(root,'content');
  const id='VBE-20260923-072',docId='1YG1dhjmB5GNrJnQEdMJ24yNZdsp5I-vsYzPlwzQm9H4';
  mkdirSync(join(word,'_rels'),{recursive:true});mkdirSync(join(word,'media'));
  writeFileSync(join(word,'_rels','document.xml.rels'),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/><Relationship Id="rId2" Target="media/image2.png"/></Relationships>');
  const make=(body:string,images:string[],path:string)=>{
    const values=[`${id}｜标题`,`【头图｜COVER_QA_PASS】`,`【公开母稿｜微信公众号】`,body,...(images.length>1?['【正文高密度信息图】','图 01｜新版核对图']:[]),'【Facebook版本】','Facebook 正文'];
    const paragraphs=values.map((text,index)=>`<w:p><w:r><w:t>${text}</w:t>${index===1?'<w:drawing><a:blip r:embed="rId1"/></w:drawing>':''}${index===4&&images.length>1?'<w:drawing><a:blip r:embed="rId2"/></w:drawing>':''}</w:r></w:p>`).join('');
    writeFileSync(join(word,'document.xml'),`<w:document>${paragraphs}</w:document>`);
    images.forEach((image,index)=>writeFileSync(join(word,'media',`image${index+1}.png`),image));
    execFileSync('zip',['-q','-r',path,'word'],{cwd:unpacked});
  };
  try{
    const original=join(root,'original.docx'),updated=join(root,'updated.docx');
    make('旧版正文',['old image'],original);
    ingestDocxContentBundle(original,content,{driveFileId:docId});
    make('新版正文',['new cover','new infographic'],updated);
    const manifestPath=join(content,id,'manifest.json');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    writeFileSync(join(content,id,'stale-readback.png'),'stale image');
    manifest.active_assets.push('stale-readback.png');
    manifest.asset_sources['stale-readback.png']={source_kind:'DRIVE_ACTIVE_ASSET_DOCX_READBACK',role:'BODY_INFOGRAPHIC'};
    writeFileSync(manifestPath,JSON.stringify(manifest));
    const result=new LocalContentRefresher(content).refreshDocx(id,readFileSync(updated));
    assert.deepEqual(result.imported,[{articleId:id,assetCount:2}]);
    assert.equal(result.publicationTasksChanged,false);
    const items=new ContentLibrary({roots:[content]}).index();
    assert.equal(items.length,1);
    assert.equal(items[0].canonicalDocument.driveFileId,docId);
    assert.match(readFileSync(items[0].payloads.wechat_official_account!,'utf8'),/新版正文/);
    assert.equal(items[0].assets.length,2);
    assert.deepEqual(items[0].assets.map(asset=>readFileSync(asset.path,'utf8')),['new cover','new infographic']);
    assert.ok(!JSON.parse(readFileSync(manifestPath,'utf8')).active_assets.includes('stale-readback.png'));
    assert.throws(()=>new LocalContentRefresher(content).refreshDocx('VBE-20260923-073',readFileSync(updated)),/CANONICAL_DOCUMENT_PACKAGE_NOT_FOUND/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
