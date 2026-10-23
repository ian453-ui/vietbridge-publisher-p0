import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ingestDocxContentBundle,readDocxSourceReview} from '../legacy-p0/src/docx-content-ingestor.ts';

const articleId='VBE-20261023-092';
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);};
function png(width,height){const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;const rows=Buffer.alloc(height*(1+width*3));for(let y=0;y<height;y++)rows[y*(1+width*3)]=0;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
const image=(name,context='')=>({image:name,context});
function fixture(t,parts){
 const root=mkdtempSync(join(tmpdir(),'v3-docx-final-')),word=join(root,'word'),media=join(word,'media');mkdirSync(media,{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}));
 const pictures={backup:png(16,9),dense:png(24,12),portrait:png(8,24),after:png(10,10)};
 for(const [name,bytes] of Object.entries(pictures))writeFileSync(join(media,name+'.png'),bytes);
 const paragraph=part=>{const value=typeof part==='string'?part:part.context;const text=value?'<w:r><w:t>'+value.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</w:t></w:r>':'';return '<w:p>'+text+(typeof part==='string'?'':'<w:r><w:drawing r:embed="rId'+part.image+'"/></w:r>')+'</w:p>';};
 const xml='<w:document xmlns:w="w" xmlns:r="r"><w:body>'+[articleId+'｜合成图文',...parts].map(paragraph).join('')+'</w:body></w:document>';
 writeFileSync(join(word,'document.xml'),xml);mkdirSync(join(word,'_rels'));writeFileSync(join(word,'_rels','document.xml.rels'),'<Relationships>'+Object.keys(pictures).map(name=>'<Relationship Id="rId'+name+'" Target="media/'+name+'.png"/>').join('')+'</Relationships>');
 const docx=join(root,'synthetic.docx');execFileSync('zip',['-q','-r',docx,'word'],{cwd:root});return {root,docx,pictures,target:join(root,'out')};
}

test('complete PUBLIC_FINAL ingests only its ordered inline images, preserving bytes, dimensions and pending QA',t=>{
 const f=fixture(t,[image('backup','COVER backup outside final'),'【PUBLIC_FINAL BEGIN】','# 合成公开正文',image('dense','FRONTLOAD_HIGH_DENSITY | dense-drive-id'),'Synthetic paragraph with correct information',image('portrait','正文竖图'),'【PUBLIC_FINAL END】',image('after','summary backup after final')]);
 assert.equal(readDocxSourceReview(f.docx,articleId).images.length,4);
 const result=ingestDocxContentBundle(f.docx,f.target),folder=join(f.target,articleId),manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8')),body=readFileSync(join(folder,articleId+'-wechat-public.md'),'utf8');
 assert.equal(result.imported[0].assetCount,2);assert.deepEqual(manifest.active_assets,['body_01_INGESTED.png','body_02_INGESTED.png']);
 assert.deepEqual(manifest.active_assets.map(name=>manifest.asset_sources[name].role),['BODY_INFOGRAPHIC','BODY_INFOGRAPHIC']);assert.equal(manifest.asset_sources[manifest.active_assets[0]].semantic_label,'FRONTLOAD_HIGH_DENSITY');
 assert.equal(manifest.asset_sources[manifest.active_assets[0]].drive_file_id,'dense-drive-id');assert.deepEqual(manifest.active_assets.map(name=>readFileSync(join(folder,name)).readUInt32BE(16)),[24,8]);assert.deepEqual(manifest.active_assets.map(name=>readFileSync(join(folder,name)).readUInt32BE(20)),[12,24]);
 for(const [index,name] of manifest.active_assets.entries())assert.equal(manifest.asset_sources[name].sha256,createHash('sha256').update(index?f.pictures.portrait:f.pictures.dense).digest('hex'));
 assert.equal((body.match(/!\[/g)||[]).length,2);assert.ok(body.indexOf('body_01_INGESTED')<body.indexOf('body_02_INGESTED'));assert.doesNotMatch(body,/backup outside|summary backup/);assert.equal(manifest.qa_status,'PENDING_FACT_QA');assert.equal(manifest.visual_qa_status,'PENDING');
});

for(const [name,parts] of [
 ['missing end',['【PUBLIC_FINAL BEGIN】','# Synthetic body',image('dense')]],
 ['missing begin',['# Synthetic body',image('dense'),'【PUBLIC_FINAL END】']],
 ['duplicate begin',['【PUBLIC_FINAL BEGIN】','【PUBLIC_FINAL BEGIN】','# Synthetic body',image('dense'),'【PUBLIC_FINAL END】']],
 ['duplicate end',['【PUBLIC_FINAL BEGIN】','# Synthetic body',image('dense'),'【PUBLIC_FINAL END】','【PUBLIC_FINAL END】']]
])test('malformed PUBLIC_FINAL '+name+' fails before materializing a package',t=>{const f=fixture(t,parts);assert.throws(()=>ingestDocxContentBundle(f.docx,f.target),/PUBLIC_FINAL_BOUNDARY_INVALID/);assert.equal(existsSync(join(f.target,articleId)),false);});

test('legacy unmarked DOCX retains its inline image behavior',t=>{const f=fixture(t,['【微信公众号母稿】','# 合成旧正文',image('dense','正文信息图')]);const result=ingestDocxContentBundle(f.docx,f.target),manifest=JSON.parse(readFileSync(join(f.target,articleId,'manifest.json'),'utf8'));assert.equal(result.imported[0].assetCount,1);assert.equal(manifest.active_assets.length,1);assert.equal(manifest.qa_status,'PENDING_FACT_QA');});

test('an image relationship reused in backup and PUBLIC_FINAL remains present in final',t=>{const f=fixture(t,[image('dense','pre-final backup'),'【PUBLIC_FINAL BEGIN】','# 合成公开正文',image('dense','FRONTLOAD_HIGH_DENSITY | dense-drive-id'),'【PUBLIC_FINAL END】']);ingestDocxContentBundle(f.docx,f.target);const folder=join(f.target,articleId),manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8')),body=readFileSync(join(folder,articleId+'-wechat-public.md'),'utf8');assert.equal(manifest.active_assets.length,1);assert.equal(manifest.asset_sources[manifest.active_assets[0]].semantic_label,'FRONTLOAD_HIGH_DENSITY');assert.match(body,/body_01_INGESTED/);assert.doesNotMatch(body,/pre-final backup/);});

test('full-source overrides retain their original image indexes after PUBLIC_FINAL selection',t=>{const f=fixture(t,[image('backup','cover backup'),'【PUBLIC_FINAL BEGIN】','# 合成公开正文',image('dense','正文密图'),image('portrait','正文竖图'),'【PUBLIC_FINAL END】',image('after','summary backup')]);ingestDocxContentBundle(f.docx,f.target,{activeAssetOverrides:{[articleId]:[{filename:'backup.png',role:'cover'},{filename:'approved-dense.png',role:'body',driveFileId:'exact-dense'},{filename:'approved-portrait.png',role:'body'},{filename:'after.png',role:'cover'}]}});const manifest=JSON.parse(readFileSync(join(f.target,articleId,'manifest.json'),'utf8'));assert.deepEqual(manifest.active_assets,['approved-dense.png','approved-portrait.png']);assert.equal(manifest.asset_sources['approved-dense.png'].drive_file_id,'exact-dense');});

test('a later PUBLIC_FINAL with no image removes formerly active inline images',t=>{const first=fixture(t,['【PUBLIC_FINAL BEGIN】','# 合成正文',image('dense'),'【PUBLIC_FINAL END】']),second=fixture(t,['【PUBLIC_FINAL BEGIN】','# 合成纯文字','【PUBLIC_FINAL END】']);ingestDocxContentBundle(first.docx,first.target);ingestDocxContentBundle(second.docx,first.target);const manifest=JSON.parse(readFileSync(join(first.target,articleId,'manifest.json'),'utf8'));assert.deepEqual(manifest.active_assets,[]);assert.equal(manifest.blocking_issue,'PUBLIC_FINAL_MEDIA_MISSING');});

test('complete PUBLIC_FINAL without an inline image stays pending and declares the gap',t=>{const f=fixture(t,['【PUBLIC_FINAL BEGIN】','# 合成纯文字','【PUBLIC_FINAL END】']);ingestDocxContentBundle(f.docx,f.target);const manifest=JSON.parse(readFileSync(join(f.target,articleId,'manifest.json'),'utf8'));assert.deepEqual(manifest.active_assets,[]);assert.equal(manifest.qa_status,'PENDING_FACT_QA');assert.equal(manifest.blocking_issue,'PUBLIC_FINAL_MEDIA_MISSING');});
