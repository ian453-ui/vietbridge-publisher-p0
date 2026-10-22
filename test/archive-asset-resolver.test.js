import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ArchiveAssetResolver,validateArchiveReference} from '../src/archive-asset-resolver.js';
import {archiveFixture,binding,sha256} from './fixtures/synthetic-archive.js';
import {syntheticVideo} from './fixtures/synthetic-video.js';

function setup(t,fixture=archiveFixture(),options={}){
 const root=mkdtempSync(join(tmpdir(),'v3-zip-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let calls=0;const resolver=new ArchiveAssetResolver({root:join(root,'cache'),fetchPart:async input=>{calls++;return fixture.fetchPart(input);},...options});t.after(()=>resolver.close());
 return {root,resolver,...fixture,calls:()=>calls};
}
test('transient cached validation budgets leave correct bytes retryable without sweep or transfer',async t=>{
 const f=setup(t),first=await f.resolver.resolve(f.reference,{binding});f.resolver.release(first.lease_id,{binding});const validate=f.resolver.entryArtifact.bind(f.resolver),calls=f.calls();
 for(const code of ['VIDEO_VALIDATION_RESOURCE_LIMIT','ARTIFACT_BATCH_TIME_LIMIT','ARCHIVE_BATCH_TIME_LIMIT','IMAGE_DECODE_INVALID_OR_RESOURCE_LIMIT']){
  f.resolver.entryArtifact=()=>{throw Error(code);};await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),new RegExp(code));
  assert.equal(f.resolver.db.prepare('SELECT state FROM archive_cache WHERE key=?').get(first.cache_key).state,'READY');assert.equal(f.resolver.db.prepare('SELECT count(*) n FROM archive_leases').get().n,0);
  f.resolver.entryArtifact=validate;const retry=await f.resolver.resolve(f.reference,{binding});assert.equal(retry.sha256,first.sha256);f.resolver.release(retry.lease_id,{binding});
 }
 assert.equal(f.calls(),calls);
});
test('manifest-selected multipart ZIP yields real decoded video and scope-bound persistent leases',async t=>{
 const f=setup(t,archiveFixture([{name:'074-trade/video.mp4',data:syntheticVideo()}],{kind:'video',member:'074-trade/video.mp4',split:3}));
 const first=await f.resolver.resolve(f.reference,{binding});assert.equal(first.validation.level,'VIDEO_DECODED');assert.equal(first.status,'MATERIALIZED');assert.equal(first.publish_allowed,false);assert.ok(!first.path.includes('.zip'));assert.equal(sha256(readFileSync(join(first.root,first.path))),f.reference.sha256);assert.equal(f.calls(),3);
 const second=new ArchiveAssetResolver({root:join(f.root,'cache'),fetchPart:()=>{throw Error('must use cache')}});
 try{const hit=await second.resolve(f.reference,{binding});assert.equal(hit.cache_key,first.cache_key);assert.notEqual(hit.lease_id,first.lease_id);second.release(hit.lease_id,{binding});}finally{second.close();}
 assert.throws(()=>f.resolver.release(first.lease_id,{binding:{...binding,account_id:'other'}}),/SCOPE_DENIED/);f.resolver.release(first.lease_id,{binding});
});
test('wrong scope, reordered/duplicate/missing parts and impossible size reject before fetching',async t=>{
 const f=setup(t,archiveFixture(undefined,{split:3}));
 await assert.rejects(()=>f.resolver.resolve(f.reference,{binding:{...binding,project_id:'other'}}),/SCOPE_DENIED/);
 for(const change of [r=>r.parts.reverse(),r=>r.parts[1].file_id=r.parts[0].file_id,r=>r.parts.pop(),r=>r.parts[0].bytes++,r=>r.member_size=101*1024*1024]){const ref=structuredClone(f.reference);change(ref);await assert.rejects(()=>f.resolver.resolve(ref,{binding}),/ARCHIVE_/);}
 assert.equal(f.calls(),0);
});
test('missing part, corrupt part, corrupt assembled hash and member hash fail without READY cache',async t=>{
 for(const variant of ['missing','part','archive','member']){
  const f=setup(t,archiveFixture(undefined,{split:2}));
  if(variant==='missing')f.files.delete(f.reference.parts[1].file_id);
  if(variant==='part')f.files.set(f.reference.parts[1].file_id,Buffer.alloc(f.reference.parts[1].bytes));
  if(variant==='archive')f.reference.archive_sha256='a'.repeat(64);
  if(variant==='member')f.reference.sha256='a'.repeat(64);
  await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/ARCHIVE_/);
  assert.equal(f.resolver.db.prepare('SELECT count(*) n FROM archive_cache').get().n,0);assert.equal(f.resolver.attempts(binding)[0].state,'FAILED');assert.deepEqual(readdirSync(join(f.root,'cache/staging')),[]);
 }
});
test('all ZIP entries reject traversal, Windows/absolute paths, symlinks, duplicates and nesting',async t=>{
 for(const bad of [{name:'../escape.md'},{name:'/escape.md'},{name:'C:/escape.md'},{name:'a\\escape.md'},{name:'link.md',mode:0o120777},{name:'article.md'},{name:'nested.zip'}]){
  const f=setup(t,archiveFixture([{name:'article.md',data:'Safe synthetic text'},{...bad,data:'bad'}]));
  await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/ARCHIVE_(UNSAFE|NON_REGULAR|DUPLICATE|NESTED)/);
  assert.equal(f.resolver.db.prepare("SELECT count(*) n FROM archive_cache WHERE state='READY'").get().n,0);
 }
});
test('compression bomb, CRC corruption, member-size lie, too many entries and fake media reject',async t=>{
 const bomb=setup(t,archiveFixture([{name:'article.md',data:'x'.repeat(100000),compress:true}]));await assert.rejects(()=>bomb.resolver.resolve(bomb.reference,{binding}),/RATIO_LIMIT/);
 const crc=archiveFixture();const damaged=Buffer.from(crc.zip);damaged[damaged.indexOf(crc.bytes)]^=1;crc.files.set('synthetic-archive',damaged);crc.reference.archive_sha256=sha256(damaged);crc.reference.parts[0].sha256=sha256(damaged);const f=setup(t,crc);await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/ZIP_INVALID/);
 const sizes=setup(t);sizes.reference.member_size++;await assert.rejects(()=>sizes.resolver.resolve(sizes.reference,{binding}),/MEMBER_SIZE/);
 const many=setup(t,archiveFixture(Array.from({length:1001},(_,i)=>({name:i+'.md',data:'Synthetic'}))));await assert.rejects(()=>many.resolver.resolve(many.reference,{binding}),/ENTRY_LIMIT/);
 const fake=setup(t,archiveFixture([{name:'fake.mp4',data:'not video'}],{kind:'video'}));await assert.rejects(()=>fake.resolver.resolve(fake.reference,{binding}),/VIDEO_/);assert.equal(fake.resolver.attempts(binding)[0].state,'FAILED');
});
test('bounded transfer times out and oversize transport fails without keeping partial staging',async t=>{
 const hanging=setup(t,archiveFixture(),{fetchPart:()=>new Promise(()=>{}),transferTimeoutMs:50});await assert.rejects(()=>hanging.resolver.resolve(hanging.reference,{binding}),/TRANSFER_TIMEOUT/);
 const large=setup(t,archiveFixture(),{fetchPart:()=>Buffer.alloc(10000)});await assert.rejects(()=>large.resolver.resolve(large.reference,{binding}),/PART_SIZE/);
 const stalled=setup(t,archiveFixture(),{fetchPart:function*(){while(true)yield Buffer.alloc(0);}});await assert.rejects(()=>stalled.resolver.resolve(stalled.reference,{binding}),/TRANSFER_INVALID/);
 for(const f of [hanging,large,stalled]){assert.deepEqual(readdirSync(join(f.root,'cache/staging')),[]);assert.equal(f.resolver.attempts(binding)[0].state,'FAILED');}
});
test('expiry preserves active uploads, cache corruption blocks and released hot files can be evicted',async t=>{
 let now=1000;const f=setup(t,archiveFixture(),{now:()=>now,ttlMs:1000}),media=await f.resolver.resolve(f.reference,{binding});now=5000;assert.deepEqual(f.resolver.sweep(),[]);
 writeFileSync(join(media.root,media.path),'corrupted');await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/CORRUPT/);assert.equal(f.calls(),1);
 f.resolver.release(media.lease_id,{binding});now=10000;assert.deepEqual(f.resolver.sweep(),[media.cache_key]);assert.equal(f.files.size,1);
});
test('concurrent cache claims do not duplicate transport; process death leaves explicit interrupted attempt',async t=>{
 let unblock;const waiting=new Promise(r=>unblock=r),fixture=archiveFixture();const f=setup(t,fixture,{fetchPart:async()=>{await waiting;return fixture.zip;}});
 const first=f.resolver.resolve(f.reference,{binding});await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/CACHE_BUSY/);unblock();const media=await first;f.resolver.release(media.lease_id,{binding});
 const childRoot=join(f.root,'child-cache'),refPath=join(f.root,'ref.json');writeFileSync(refPath,JSON.stringify(f.reference));
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {ArchiveAssetResolver} from './src/archive-asset-resolver.js';import {readFileSync} from 'node:fs';const ref=JSON.parse(readFileSync(process.argv[2]));const r=new ArchiveAssetResolver({root:process.argv[1],fetchPart:()=>process.exit(7)});await r.resolve(ref,{binding:${JSON.stringify(binding)}});`,childRoot,refPath],{cwd:new URL('..',import.meta.url).pathname});assert.equal(child.status,7,String(child.stderr));
 const recovered=new ArchiveAssetResolver({root:childRoot,fetchPart:fixture.fetchPart});try{assert.equal(recovered.sweep().length,1);assert.equal(recovered.attempts(binding)[0].state,'INTERRUPTED');const next=await recovered.resolve(f.reference,{binding});recovered.release(next.lease_id,{binding});}finally{recovered.close();}
});
test('versioned loose reference migration and rollback preserve original bytes and reject identity changes',async t=>{
 const f=setup(t),original=join(f.root,'original');mkdirSync(original);writeFileSync(join(original,'article.md'),f.bytes);
 const before=readFileSync(join(original,'article.md')),registered=f.resolver.registerLooseReference('article',{binding,root:original,path:'article.md',kind:'knowledge_article',sha256:f.reference.sha256});assert.equal(registered.revision,1);
 const media=await f.resolver.resolve(f.reference,{binding}),migrated=f.resolver.migrateReference('article',{binding,leaseId:media.lease_id,expectedRevision:1});assert.equal(migrated.revision,2);assert.equal(migrated.reference.type,'ZIP_BYTE_PARTS');assert.equal(migrated.delete_original_allowed,false);
 assert.throws(()=>f.resolver.migrateReference('article',{binding,leaseId:media.lease_id,expectedRevision:1}),/CONFLICT/);
 assert.throws(()=>f.resolver.reference('article',{binding:{...binding,content_id:'SYNTHETIC-ARCHIVE-074-LUXSHARE'}}),/NOT_FOUND/);
 const rollback=f.resolver.rollbackReference('article',{binding,expectedRevision:2,toRevision:1});assert.equal(rollback.revision,3);assert.equal(rollback.reference.type,'LOOSE_FILE');assert.deepEqual(readFileSync(join(original,'article.md')),before);f.resolver.release(media.lease_id,{binding});
});

test('encrypted, unsupported compression and native multi-disk headers reject before extraction',async t=>{
 for(const variant of ['encrypted','compression','disk']){
  const fixture=archiveFixture(),zip=Buffer.from(fixture.zip),central=zip.indexOf(Buffer.from([0x50,0x4b,1,2]));
  if(variant==='encrypted'){zip.writeUInt16LE(1,6);zip.writeUInt16LE(1,central+8);}
  if(variant==='compression'){zip.writeUInt16LE(12,8);zip.writeUInt16LE(12,central+10);}
  if(variant==='disk')zip.writeUInt16LE(1,central+34);
  fixture.files.set('synthetic-archive',zip);fixture.reference.archive_sha256=sha256(zip);fixture.reference.parts[0].sha256=sha256(zip);
  const f=setup(t,fixture);await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/ARCHIVE_(COMPRESSION|NATIVE_MULTIPART|ZIP_INVALID)/);
 }
});
test('shared cache reservations bound aggregate staging before fetch; symlink substitution cannot escape cache',async t=>{
 const f=setup(t),large={...f.reference,archive_size:128*1024*1024};
 for(let i=0;i<2;i++)f.resolver.db.prepare('INSERT INTO archive_cache VALUES(?,?,?,?,?,?)').run(String(i).repeat(64),'BUILDING',JSON.stringify(large),'00000000-0000-0000-0000-00000000000'+i,process.pid,9999999999999);
 await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/CACHE_CAPACITY/);assert.equal(f.calls(),0);
 f.resolver.db.exec('DELETE FROM archive_cache');const media=await f.resolver.resolve(f.reference,{binding});
 const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'media.md'),f.bytes);
 const entry=join(f.root,'cache/entries',media.cache_key);rmSync(entry,{recursive:true});symlinkSync(outside,entry);
 await assert.rejects(()=>f.resolver.resolve(f.reference,{binding}),/CACHE_CORRUPT/);assert.deepEqual(readFileSync(join(outside,'media.md')),f.bytes);f.resolver.release(media.lease_id,{binding});
});
