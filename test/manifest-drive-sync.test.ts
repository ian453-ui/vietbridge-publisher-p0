import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManifestDriveSync} from '../src/manifest-drive-sync.ts';
import {ContentLibrary} from '../src/content-library.ts';

test('registered manifest source discovers new Markdown and image, updates in place and is idempotent',async()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-manifest-sync-'));
  try{
    const image=Buffer.from('image bytes');
    const body=Buffer.from('---\npublish_title: Visa title\npublish_caption: Approved caption\n---\n# Visa title\nFull article');
    const item={content_id:'CNVISA-FB-011',title:'Visa title',status:'READY',body_source:'READY/content/CNVISA-FB-011.md',content_drive_file_id:'doc-id',primary_image:'READY/assets/CNVISA-FB-011_primary.png',primary_image_drive_file_id:'image-id',primary_image_sha256:createHash('sha256').update(image).digest('hex')};
    const manifest=Buffer.from(JSON.stringify({project_id:'CHINA-VISA-TRAVEL-SOCIAL',workspace:'independent-client',status:'READY',manifest_revision:7,items:[item]}));
    const blobs=new Map([['manifest-id',manifest],['doc-id',body],['image-id',image]]);
    const sync=new ManifestDriveSync({downloadRaw:async id=>{const bytes=blobs.get(id);if(!bytes)throw Error('not found');return bytes;}},root,[{projectId:'CHINA-VISA-TRAVEL-SOCIAL',workspaceId:'ws-client',manifestDriveFileId:'manifest-id',relativeRoot:'clients/china-visa-travel'}]);
    const first=await sync.run() as Array<{updated:number}>;assert.equal(first[0].updated,3);
    const second=await sync.run() as Array<{updated:number}>;assert.equal(second[0].updated,0);
    const library=new ContentLibrary({roots:[root]});const found=library.index().filter(p=>p.articleId==='CNVISA-FB-011');
    assert.equal(found.length,1);assert.equal(found[0].readiness,'READY');assert.equal(found[0].assets.length,1);
    assert.equal(readFileSync(found[0].payloads.facebook!,'utf8').trim(),'Approved caption');
  }finally{rmSync(root,{recursive:true,force:true});}
});
