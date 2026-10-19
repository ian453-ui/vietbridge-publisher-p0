import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fixture,image} from './helpers/manual-sync-fixture.js';
import {PNG,JPEG,WEBP} from './helpers/image-fixtures.js';
import {validateImage} from '../src/image-validation.js';
import {ContentLibrary} from '../src/publisher-core/content-library.ts';
const sha=b=>createHash('sha256').update(b).digest('hex'),ID='MOCK-DECODE-011';
const crc=b=>{let n=0xffffffff;for(const byte of b){n^=byte;for(let i=0;i<8;i++)n=n>>>1^(n&1?0xedb88320:0);}return (n^0xffffffff)>>>0;};
function headerSize(width,height){const b=Buffer.from(PNG);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);b.writeUInt32BE(crc(b.subarray(12,29)),29);return b;}
function fixtureImages(t){
 const f=fixture(t);for(const dir of ['READY/content','READY/assets','GPT-INBOX/r2'])mkdirSync(join(f.client,dir),{recursive:true});const old=Buffer.concat([image,Buffer.alloc(200,7)]),manifest={status:'READY',manifest_revision:9,items:[{content_id:ID,title:'Old fixture',status:'READY',content_revision:1,visual_revision:7,body_source:'READY/content/old.md',primary_image:'READY/assets/old.png',primary_image_sha256:sha(old)}]},manifestPath=join(f.client,'publisher-manifest.json');
 writeFileSync(join(f.client,'READY/content/old.md'),'# Old fixture\n\nOriginal complete fictional caption.\n');writeFileSync(join(f.client,'READY/assets/old.png'),old);writeFileSync(manifestPath,JSON.stringify(manifest));const original=f.library.items(f.ws.id,{refresh:true})[0],content=f.library.import(f.ws.id,[{key:original.key,revision:original.revision}])[0];
 const groups=Array.from({length:5},(_,i)=>f.store.addGroup(f.ws.id,{account_id:f.account.id,name:'Fake decoded group '+i,url:'https://www.facebook.com/groups/'+(810000+i)}));for(const job of f.store.createGroupJobs(f.ws.id,{account_id:f.account.id,content_ids:[content.id],group_ids:groups.map(g=>g.id)})){const attempt=randomUUID();f.store.db.prepare("UPDATE group_jobs SET state='PUBLISHED',attempt_id=? WHERE id=?").run(attempt,job.id);f.store.db.prepare('INSERT INTO form_snapshots VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),f.ws.id,job.id,attempt,content.body,content.media_json,'{"fixture":true}','2026-01-01T00:00:00Z');}
 const unknown=f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:content.id});f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(unknown.id);
 function tree(root){return readdirSync(root,{withFileTypes:true}).flatMap(d=>d.isDirectory()?tree(join(root,d.name)):[{path:join(root,d.name),sha256:sha(readFileSync(join(root,d.name)))}]).sort((a,b)=>a.path.localeCompare(b.path));}
 const capture=()=>({manifest:readFileSync(manifestPath).toString(),ready:tree(join(f.client,'READY')),frozen:tree(join(f.root,'frozen')),rows:Object.fromEntries(['group_content','group_library_imports','group_jobs','form_snapshots','publisher_jobs','events'].map(name=>[name,f.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]))});
 const put=(bytes=PNG,extension='png',extra={})=>{const folder=join(f.client,'GPT-INBOX/r2'),name='primary.'+extension;writeFileSync(join(folder,name),bytes);writeFileSync(join(folder,'submission.json'),JSON.stringify({schema_version:1,status:'READY_FOR_REVIEW',content_id:ID,title:'New fixture',facebook_caption:'Corrected complete fictional caption.',revision_number:2,visual_revision:8,primary_image:name,primary_image_sha256:sha(bytes),...extra}));return join(folder,name);};
 const pending=()=>f.library.items(f.ws.id,{refresh:true}).find(p=>p.reviewStatus),approve=p=>f.library.approveGpt(f.ws.id,p.key,p.revision,p.previousRevision),noPlatform=()=>{assert.equal(f.calls(),0);assert.equal(f.submissions(),0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publication_intents').get().n,0);};
 return {...f,manifestPath,put,pending,approve,capture,noPlatform,content};
}

test('correct-hash non-image, forged extension, corrupt or truncated pixels and invalid declarations cannot approve or import, preserving old five published jobs and UNKNOWN',t=>{
 const f=fixtureImages(t),before=f.capture(),corrupt=Buffer.from(PNG);corrupt[45]^=1;
 const cases=[['non-image with correct SHA',Buffer.alloc(256,65),'png',{}],['JPEG pretending PNG',JPEG,'png',{}],['truncated PNG',PNG.subarray(0,PNG.length/2),'png',{}],['bad PNG CRC',corrupt,'png',{}],['actual zero width',headerSize(0,1402),'png',{}],['enormous decoded pixels',headerSize(80000,80000),'png',{}],['wrong declared1080x1350',PNG,'png',{primary_image_width:1080,primary_image_height:1350}],['zero declaration',PNG,'png',{primary_image_width:0,primary_image_height:1402}],['missing declaration half',PNG,'png',{primary_image_width:1122}],['wrong dimensions object',PNG,'png',{primary_image_dimensions:{width:1122,height:1350}}]];
 for(const [label,bytes,extension,extra] of cases){f.put(bytes,extension,extra);const p=f.pending();assert.equal(p.reviewStatus,'INVALID',label);assert.throws(()=>f.approve(p));assert.throws(()=>f.library.import(f.ws.id,[{key:p.key,revision:p.revision}]));assert.deepEqual(f.capture(),before,label);}
 f.noPlatform();console.log(JSON.stringify({fixture_only:true,image_failures_blocked:cases.length,old_manifest_READY_files_audit_unchanged:true,published_groups_unchanged:5,UNKNOWN_unchanged:true,approval_events:0,driver_drive_calls:0}));
});

test('valid decoded PNG1122x1402, JPEG and WebP can follow the original c2/v8 approval and import without fixed1080 dimensions',t=>{
 for(const [bytes,ext,width,height,format] of [[PNG,'png',1122,1402,'PNG'],[JPEG,'jpg',64,80,'JPEG'],[WEBP,'webp',64,80,'WEBP']]){
  const f=fixtureImages(t);f.put(bytes,ext,{primary_image_width:width,primary_image_height:height,primary_image_dimensions:{width,height}});const p=f.pending();assert.equal(p.reviewStatus,'UPDATE_AVAILABLE');assert.equal(p.assets[0].width,width);assert.equal(p.assets[0].height,height);assert.equal(p.assets[0].format,format);assert.equal(f.approve(p).visual_revision,8);const entry=JSON.parse(readFileSync(f.manifestPath)).items[0];assert.equal(entry.primary_image_width,width);assert.equal(entry.primary_image_height,height);assert.equal(entry.primary_image_format,format);const current=f.library.items(f.ws.id,{refresh:true}).find(p=>!p.reviewStatus);assert.equal(current.ready,true);const next=f.library.import(f.ws.id,[{key:current.key,revision:current.revision}])[0];assert.notEqual(next.id,f.content.id);f.noPlatform();
 }
});

test('image decoding is repeated before approval and exact-byte import; same-size/time replacement after preview is rejected before any new frozen write',t=>{
 const f=fixtureImages(t),before=f.capture(),path=f.put(),p=f.pending();writeFileSync(path,Buffer.alloc(PNG.length,65));assert.throws(()=>f.approve(p));assert.deepEqual(f.capture(),before);
 f.put();const accepted=f.pending();f.approve(accepted);const current=f.library.items(f.ws.id,{refresh:true}).find(p=>!p.reviewStatus),entry=JSON.parse(readFileSync(f.manifestPath)).items[0],target=join(f.client,entry.primary_image),st=statSync(target),after=f.capture();writeFileSync(target,Buffer.alloc(PNG.length,65));utimesSync(target,st.atime,st.mtime);assert.throws(()=>f.library.import(f.ws.id,[{key:current.key,revision:current.revision}]));assert.equal(f.store.db.prepare('SELECT count(*) n FROM group_library_imports').get().n,1);assert.deepEqual(after.frozen,f.capture().frozen);f.noPlatform();
});

test('already-approved bad pixels cannot become a successful retry or READY catalogue even when its stored file hash is refreshed',t=>{
 const f=fixtureImages(t);f.put();const accepted=f.pending();f.approve(accepted);const manifest=JSON.parse(readFileSync(f.manifestPath)),entry=manifest.items[0],bad=Buffer.alloc(256,65);writeFileSync(join(f.client,entry.primary_image),bad);entry.primary_image_sha256=sha(bad);writeFileSync(f.manifestPath,JSON.stringify(manifest));const before=f.capture();assert.throws(()=>f.approve(accepted));const row=f.library.items(f.ws.id,{refresh:true}).find(p=>!p.reviewStatus);assert.equal(row.ready,false);const canonical=new ContentLibrary({roots:[f.root]}).index().find(p=>p.articleId===ID);assert.equal(canonical.readiness,'BLOCKED');assert.ok(canonical.blockingReasons.includes('APPROVED_IMAGE_INVALID'));assert.deepEqual(f.capture(),before);assert.equal(readdirSync(f.client).includes('.publisher-public'),false);f.noPlatform();
});

test('a prior successful decode cache cannot bypass a changed size declaration or file extension',()=>{
 assert.deepEqual(validateImage(PNG,'.png',{primary_image_dimensions:{width:1122,height:1402}}),{format:'PNG',width:1122,height:1402,frames:1});assert.throws(()=>validateImage(PNG,'.png',{primary_image_width:1080,primary_image_height:1350}),/DECLARED_DIMENSIONS/);assert.throws(()=>validateImage(PNG,'.jpg'),/FORMAT/);assert.throws(()=>validateImage(PNG,'.png',{primary_image_dimensions:{width:1122}}),/DECLARED_DIMENSIONS/);
});
