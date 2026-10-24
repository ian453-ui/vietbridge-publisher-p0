import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {stageV3Media} from '../src/v3-media-staging.js';

const siteJobId='e11a0a0b-36d1-4b96-a547-650324836d48';
test('private V3 media staging verifies complete bytes and is idempotent without replacing a prior object',async t=>{
 const root=mkdtempSync(join(tmpdir(),'vb-v3-media-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic-image')]),sha256=createHash('sha256').update(bytes).digest('hex');
 const command=()=>({root,siteJobId,ordinal:0,mime:'image/png',sha256,size:bytes.length,stream:Readable.from([bytes.subarray(0,5),bytes.subarray(5)])});
 const first=await stageV3Media(command());assert.equal(first.duplicate,false);assert.deepEqual(readFileSync(first.path),bytes);assert.equal(statSync(first.path).mode&0o077,0);
 const second=await stageV3Media(command());assert.equal(second.duplicate,true);assert.equal(second.path,first.path);
 await assert.rejects(stageV3Media({...command(),sha256:'a'.repeat(64)}),/V3_MEDIA_CONFLICT/);
 assert.equal(readdirSync(join(root,siteJobId)).length,1);
});
test('bad media digest, size and path are rejected without a staged file',async t=>{
 const root=mkdtempSync(join(tmpdir(),'vb-v3-media-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('not-an-image'),sha256=createHash('sha256').update(bytes).digest('hex');
 await assert.rejects(stageV3Media({root,siteJobId,ordinal:1,mime:'image/png',sha256,size:bytes.length,stream:Readable.from([bytes])}),/V3_MEDIA_HASH_OR_FORMAT_MISMATCH/);
 await assert.rejects(stageV3Media({root,siteJobId,ordinal:1,mime:'image/png',sha256,size:bytes.length+1,stream:Readable.from([bytes])}),/V3_MEDIA_HASH_OR_FORMAT_MISMATCH/);
 await assert.rejects(stageV3Media({root,siteJobId:'../escape',ordinal:1,mime:'image/png',sha256,size:bytes.length,stream:Readable.from([bytes])}),/V3_MEDIA_MANIFEST_INVALID/);
 assert.equal(readdirSync(join(root,siteJobId)).length,0);
});
