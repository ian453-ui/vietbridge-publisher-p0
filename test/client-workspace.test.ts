import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContentLibrary} from '../src/content-library.ts';

test('client visual package is recognized but blocked until public Facebook body exists',()=>{
  const base=mkdtempSync(join(tmpdir(),'publisher-client-'));
  const client=join(base,'clients','lp'),content=join(client,'READY','content'),assets=join(client,'READY','assets');
  mkdirSync(content,{recursive:true});mkdirSync(assets,{recursive:true});
  const md=join(content,'CNVISA-FB-001.md');
  writeFileSync(md,'---\ncontent_id: CNVISA-FB-001\n---\n# Visa\nVisual package only. Use the approved Vietnamese Facebook body associated with this content_id.');
  writeFileSync(join(assets,'cover.png'),'cover');writeFileSync(join(assets,'body.png'),'body');
  writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[{content_id:'CNVISA-FB-001',status:'READY',title:'Visa',cover:'READY/assets/cover.png',infographic:'READY/assets/body.png'}]}));
  const library=new ContentLibrary({roots:[base]});
  const [item]=library.index();
  assert.equal(item.articleId,'CNVISA-FB-001');
  assert.equal(item.assets.length,2);
  assert.deepEqual(item.blockingReasons,['PUBLIC_PAYLOAD_MISSING']);
  writeFileSync(md,'---\ncontent_id: CNVISA-FB-001\n---\n# Visa\nĐây là nội dung Facebook công khai đã duyệt.');
  const [updated]=library.index();
  assert.equal(updated.readiness,'READY');
  assert.notEqual(updated.version,item.version);
  assert.match(String(updated.payloads.facebook),/\.publisher-public\/CNVISA-FB-001-facebook-public\.txt$/);
  assert.equal(readFileSync(String(updated.payloads.facebook),'utf8'),'Đây là nội dung Facebook công khai đã duyệt.\n');
});

test('client revision 4 uses approved caption and primary image, not legacy visuals',()=>{
  const base=mkdtempSync(join(tmpdir(),'publisher-client-rev4-'));
  const client=join(base,'clients','lp'),content=join(client,'READY','content'),assets=join(client,'READY','assets');
  mkdirSync(content,{recursive:true});mkdirSync(assets,{recursive:true});
  writeFileSync(join(content,'CNVISA-FB-001.md'),'---\ncontent_id: CNVISA-FB-001\npublish_title: Public title\npublish_caption: |-\n  Approved first line\n  \n  Approved CTA\n---\n# Old heading\nStale body');
  writeFileSync(join(assets,'primary.png'),'new primary');writeFileSync(join(assets,'cover.png'),'old cover');
  writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[{content_id:'CNVISA-FB-001',status:'READY',title:'Old title',primary_image:'READY/assets/primary.png',cover:'READY/assets/cover.png'}]}));
  const [item]=new ContentLibrary({roots:[base]}).index();
  assert.equal(item.readiness,'READY');assert.equal(item.title,'Public title');
  assert.deepEqual(item.assets.map(a=>a.filename),['primary.png']);
  assert.equal(readFileSync(String(item.payloads.facebook),'utf8'),'Approved first line\n\nApproved CTA\n');
});
