import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {importProductionBatch} from '../src/batch-bundle-importer.ts';
import {ContentLibrary} from '../src/content-library.ts';

test('batch public copy and sibling images remain usable without a visual report',()=>{
  const root=mkdtempSync(join(tmpdir(),'batch-import-')),source=join(root,'source'),target=join(root,'target');
  try{
    mkdirSync(join(source,'markdown'),{recursive:true});mkdirSync(join(source,'images'));
    writeFileSync(join(source,'manifest.json'),JSON.stringify({batch:'VBE-20260920-060..061',status:'CONTENT_QA_PASS / VISUAL_QA_PASS',items:[{content_id:'VBE-20260920-061',title:'电商平台代扣税不等于不用开票',cover_asset:'VBE-20260920-061_cover_QA_PASS.png',body_asset:'VBE-20260920-061_body_main_QA_PASS.png'}]}));
    writeFileSync(join(source,'images','VBE-20260920-061_cover_QA_PASS.png'),'cover');
    writeFileSync(join(source,'images','VBE-20260920-061_body_main_QA_PASS.png'),'body');
    writeFileSync(join(source,'markdown','VBE-20260920-061.md'),`---\ncontent_id: VBE-20260920-061\n---\n【故事开场】\n故事\n【微信公众号母稿】\n公众号正文\n【行动清单】\n- 对账\n【培训转化钩子】\n工作坊\n【Facebook】\nFacebook正文\n【LinkedIn】\nLinkedIn body\n【小红书】\n标题：平台代扣税\n小红书正文\n【FACT_QA｜内部，不进入公开payload】\n内部资料`);
    const first=importProductionBatch(source,target,{driveDocumentId:'document',driveFolderId:'folder'});
    const second=importProductionBatch(source,target,{driveDocumentId:'document',driveFolderId:'folder'});
    assert.equal(first.imported,1);assert.equal(second.imported,1);
    const item=new ContentLibrary({roots:[target]}).index()[0];
    assert.equal(item.articleId,'VBE-20260920-061');assert.equal(item.assets.length,2);
    assert.deepEqual(Object.keys(item.payloads).sort(),['facebook','linkedin','wechat_channels','wechat_official_account','xiaohongshu']);
    assert.equal(item.canonicalDocument.driveFileId,'document');assert.equal(item.canonicalDocument.sourceAnchor,'VBE-20260920-061');
    assert.equal(item.readiness,'READY');assert.ok(!item.blockingReasons.includes('VISUAL_QA_PENDING'));
    assert.doesNotMatch(readFileSync(item.payloads.wechat_official_account!,'utf8'),/FACT_QA/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
