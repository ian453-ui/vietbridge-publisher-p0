import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {v3MetricDemo} from '../scripts/v3-metric-demo.mjs';
import {v3ArchiveDemo} from '../scripts/v3-archive-demo.mjs';
import {importOfflineMetrics,readOfflineFile} from '../src/offline-intake.js';

test('offline metric command imports only local bounded evidence and exact repeats stay duplicate',t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-offline-metric-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const out=join(root,'demo'),demo=v3MetricDemo(out),db=new DatabaseSync(demo.dbPath);t.after(()=>db.close());
 const result=spawnSync(process.execPath,['scripts/v3-offline-intake.mjs','--kind','metrics','--db',demo.dbPath,'--root',out],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.receipts.length,3);assert.ok(report.receipts.every(r=>r.status==='DUPLICATE'));assert.equal(db.prepare('SELECT count(*) n FROM metric_observations').get().n,3);assert.equal(db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
 const manifest=JSON.parse(readFileSync(join(out,'offline-metrics.json')));manifest.entries[1].observation.source.sha256='f'.repeat(64);writeFileSync(join(out,'broken.json'),JSON.stringify(manifest));db.exec('DELETE FROM metric_observations; DELETE FROM metric_raw_evidence; DELETE FROM metric_series; DELETE FROM metric_targets');
 assert.throws(()=>importOfflineMetrics(db,{root:out,manifestPath:'broken.json'}),/HASH_MISMATCH/);for(const table of ['metric_observations','metric_raw_evidence','metric_series','metric_targets'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0);
});
test('offline file paths/size/symlink escapes and undeclared packet fields reject',t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-offline-path-'));t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'allowed'),'abc');assert.throws(()=>readOfflineFile(root,'../outside',10),/PATH_INVALID/);assert.throws(()=>readOfflineFile(root,'https://example.invalid/media',10),/PATH_INVALID/);assert.throws(()=>readOfflineFile(root,'allowed',2),/SIZE_LIMIT/);symlinkSync('/etc/hosts',join(root,'escape'));assert.throws(()=>readOfflineFile(root,'escape',10000),/PATH_ESCAPE/);
});
test('offline archive CLI uses exact local part map -> decoder -> original Review, with no cold deletion',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-offline-zip-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const out=join(root,'demo'),demo=await v3ArchiveDemo(out),parts=readdirSync(demo.cold_directory).map(file_id=>({file_id,path:'synthetic-cold-archive/'+file_id})),manifest={schema_version:1,kind:'ARCHIVE_PRODUCTION',request:'archive-request.json',archive_manifest:'archive-manifest.json',parts};writeFileSync(join(out,'offline-archive.json'),JSON.stringify(manifest));
 const args=['scripts/v3-offline-intake.mjs','--kind','archive','--db',demo.dbPath,'--root',out,'--cache',join(out,'offline-hot-cache')],run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stderr);const receipt=JSON.parse(run.stdout);assert.equal(receipt.status,'DUPLICATE');assert.equal(receipt.cleanup_status,'COMPLETE');assert.equal(receipt.archive_members,10);assert.equal(readdirSync(demo.cold_directory).length,3);
 manifest.parts[0].path='../outside';writeFileSync(join(out,'offline-archive.json'),JSON.stringify(manifest));const failed=spawnSync(process.execPath,[...args.slice(0,-1),join(out,'invalid-hot-cache')],{encoding:'utf8',timeout:10000});assert.equal(failed.status,1);assert.match(failed.stderr,/OFFLINE_PATH_INVALID/);
});
