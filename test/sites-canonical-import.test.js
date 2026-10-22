import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {canonicalFixture} from './fixtures/canonical-source.js';
import {seedCloudApproval,syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
import {AsyncApprovalStore} from '../src/sites/async-approval-store.js';
import {AsyncReviewStore} from '../src/sites/async-review-store.js';
import {AsyncSourceImport} from '../src/sites/async-source-import.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
const ingest=x=>x.imports.import(x.reference());
async function approved(x){const r=await ingest(x);await seedCloudApproval(x.f,x.state.packet,x.scope);const a=new AsyncApprovalStore(x.f.db,x.options),v=await a.view(r.id,x.scope,{admin:true});assert.equal(v.can_decide,true);await a.decide(r.id,approvalCommand(v),x.scope,{authority:syntheticAdmin});return {id:r.id,approvals:a};}
test('canonical metadata/document/image -> original persistent Review, exact identity, no publication and idempotent restart',async t=>{
 const x=await canonicalFixture(t),r=await ingest(x);assert.equal(r.status,'REVIEW_REQUIRED');assert.equal(r.publish_allowed,false);const detail=await new AsyncReviewStore(x.f.db,x.options).detail(x.workspace,x.accountId,r.id);assert.equal(detail.source_import.state,'IMPORTED');assert.equal(detail.source_import.summary.slug,'trade');assert.equal(detail.assets.length,2);assert.equal(detail.report.items[0].artifacts.find(a=>a.kind==='cover').validation.level,'IMAGE_DECODED');
 const reads=x.state.reads.length,other=cloudD1Fixture(x.path,{initialize:false});try{assert.equal((await new AsyncSourceImport(other.db,{...x.options,provider:x.provider}).import(x.reference())).status,'DUPLICATE');}finally{other.close();}assert.equal(x.state.reads.length,reads);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,1);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);
});
test('same numeric suffix across dates remains two independent source identities and bodies',async t=>{const a=await canonicalFixture(t),b=await canonicalFixture(t,{existing:a,contentId:'SYNTHETIC-20261021-074',slug:'license'});const ra=await ingest(a),rb=await ingest(b);assert.notEqual(ra.source_key,rb.source_key);const reviews=new AsyncReviewStore(a.f.db,a.options),body=await reviews.asset(a.workspace,a.accountId,ra.id,a.binding.content_id,'body');assert.match(Buffer.from(body.data).toString(),/20261022-074/);assert.equal(a.f.sql.prepare('SELECT count(*) n FROM sites_source_heads').get().n,2);});
test('cross-project and account denied before media reads; exact wrong document/image association is blocked',async t=>{
 const x=await canonicalFixture(t);await assert.rejects(x.imports.import({...x.reference(),accountId:'wrong'}),/SCOPE_DENIED/);x.state.manifest.project_id='OTHER';x.state.raw=Buffer.from(JSON.stringify(x.state.manifest));await assert.rejects(ingest(x),/SOURCE_PROJECT_MISMATCH/);assert.equal(x.state.reads.length,0);x.state.manifest.project_id=x.binding.project_id;x.advance(m=>{m.primary_image_source_doc_id='OTHER-DOCUMENT';});const r=await ingest(x);assert.equal(r.status,'SOURCE_BLOCKED');assert.equal(r.reason,'SOURCE_IMAGE_DOCUMENT_MISMATCH');assert.equal(x.state.reads.length,0);
});
for(const failure of ['missing','swapped','qa','empty_assets'])test('source update '+failure+' invalidates old approval even when replacement cannot import',async t=>{
 const x=await canonicalFixture(t),old=await approved(x);x.advance(m=>{if(failure==='qa')m.qa_status='MOBILE_READABILITY_RETEST_PENDING';if(failure==='empty_assets')m.active_assets=[];});
 if(failure==='missing')x.files.delete(x.state.manifest.primary_image_drive_file_id);if(failure==='swapped')x.state.alterRead=r=>r.file_id.startsWith('image')?{...r,source_doc_id:'another-body'}:r;
 if(['missing','swapped'].includes(failure))await assert.rejects(ingest(x),/SOURCE_FILE_/);else assert.ok(['SOURCE_BLOCKED','QA_BLOCKED'].includes((await ingest(x)).status));
 const v=await old.approvals.view(old.id,x.scope,{admin:true});assert.equal(v.state,'REVOKED');assert.equal(v.can_decide,false);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,1);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_source_import_receipts').get().n,1);
});
test('same upstream revision with different manifest is a retained conflict, never silent overwrite',async t=>{
 const x=await canonicalFixture(t),old=await approved(x);x.state.manifest.title='Changed same version';x.state.raw=Buffer.from(JSON.stringify(x.state.manifest));await assert.rejects(ingest(x),/SOURCE_VERSION_CONFLICT/);assert.equal((await old.approvals.view(old.id,x.scope)).state,'REVOKED');
});
test('source commit loss and partial receipt failure reconcile existing Review instead of repeating inspection',async t=>{
 const x=await canonicalFixture(t),base=x.f.db.batch;let fail=true;x.f.db.batch=async ss=>{if(fail&&ss.some(s=>s.query.startsWith('INSERT INTO sites_source_import_receipts'))){fail=false;throw Error('SYNTHETIC_RECEIPT_FAILURE');}return base(ss);};await assert.rejects(ingest(x),/SYNTHETIC_RECEIPT_FAILURE/);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,1);const reads=x.state.reads.length;assert.equal((await ingest(x)).status,'REVIEW_REQUIRED');assert.equal(x.state.reads.length,reads);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_source_import_receipts').get().n,1);
});
test('source version change between approval preflight and batch denies atomic approval',async t=>{
 const x=await canonicalFixture(t),r=await ingest(x);await seedCloudApproval(x.f,x.state.packet,x.scope);const a=new AsyncApprovalStore(x.f.db,x.options),cmd=approvalCommand(await a.view(r.id,x.scope)),base=x.f.db.batch;let fired=false;
 x.f.db.batch=async ss=>{if(!fired&&ss.some(s=>s.query.startsWith('INSERT INTO sites_approval_events'))){fired=true;const second=new DatabaseSync(x.path);try{second.prepare("UPDATE sites_source_heads SET state='QA_BLOCKED',reason='SOURCE_QA_REVIEW_REQUIRED'").run();}finally{second.close();}}return base(ss);};await assert.rejects(a.decide(r.id,cmd,x.scope,{authority:syntheticAdmin}),/APPROVAL_CONCURRENT_CHANGE/);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events').get().n,0);
});

test('split ZIP image and loose body use original resolver and decoded Review snapshot; corruption invalidates prior approval',async t=>{
 const {ArchiveAssetResolver}=await import('../src/archive-asset-resolver.js'),{archiveFixture}=await import('./fixtures/synthetic-archive.js'),{join}=await import('node:path');
 const x=await canonicalFixture(t),image=x.files.get(x.state.manifest.primary_image_drive_file_id),zip=archiveFixture([{name:'materials/cover.png',data:image}],{kind:'cover',split:3,scope:{project_id:x.workspace,account_id:x.accountId,content_id:x.binding.content_id}});let corrupt=false,calls=0;
 const resolver=new ArchiveAssetResolver({root:join(x.root,'archive-cache'),fetchPart:async args=>{calls++;const bytes=await zip.fetchPart(args);return corrupt?Buffer.from('corrupt'):bytes;}});t.after(()=>resolver.close());x.inspector.resolver=resolver;
 x.advance(m=>{m.primary_image_archive=zip.reference;});const old=await approved(x);assert.equal(calls,3);assert.equal(x.state.reads.some(id=>id.startsWith('image-')),false);assert.equal(resolver.db.prepare('SELECT count(*) n FROM archive_leases').get().n,0);
 const detail=await new AsyncReviewStore(x.f.db,x.options).detail(x.workspace,x.accountId,old.id);assert.equal(detail.report.items[0].artifacts.find(a=>a.kind==='cover').validation.level,'IMAGE_DECODED');
 // Different archive identity prevents reuse of the verified cache; transport corrupts it.
 x.advance(m=>{m.primary_image_archive={...zip.reference,archive_file_id:'new-synthetic-archive'};});corrupt=true;await assert.rejects(ingest(x),/ARCHIVE_PART_/);assert.equal((await old.approvals.view(old.id,x.scope)).state,'REVOKED');assert.equal(resolver.db.prepare('SELECT count(*) n FROM archive_leases').get().n,0);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,1);
});
test('archive traversal and cross-project references are rejected before transport',async t=>{
 const {archiveFixture}=await import('./fixtures/synthetic-archive.js'),x=await canonicalFixture(t),z=archiveFixture([{name:'cover.png',data:x.files.get(x.state.manifest.primary_image_drive_file_id)}],{kind:'cover',scope:{project_id:x.workspace,account_id:x.accountId,content_id:x.binding.content_id}});let calls=0;x.inspector.resolver={resolve:async()=>{calls++;throw Error('UNEXPECTED_TRANSPORT');}};
 x.advance(m=>{m.primary_image_archive={...z.reference,member_path:'../cover.png'};});assert.equal((await ingest(x)).status,'SOURCE_BLOCKED');
 x.advance(m=>{m.primary_image_archive={...z.reference,project_id:'OTHER'};});assert.equal((await ingest(x)).reason,'ARCHIVE_SCOPE_DENIED');assert.equal(calls,0);assert.equal(x.state.reads.length,0);
});
test('lost final acknowledgement returns committed receipt and never repeats media or changes UNKNOWN jobs',async t=>{
 const x=await canonicalFixture(t),base=x.f.db.batch;let lost=false;x.f.db.batch=async ss=>{const r=await base(ss);if(!lost&&ss.some(s=>s.query.startsWith('INSERT INTO sites_source_import_receipts'))){lost=true;throw Error('SYNTHETIC_ACK_LOST');}return r;};
 x.f.sql.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='synthetic-original-intent'").run();const before=x.f.sql.prepare('SELECT * FROM publisher_jobs').all();assert.equal((await ingest(x)).status,'DUPLICATE');const reads=x.state.reads.length;await ingest(x);assert.equal(x.state.reads.length,reads);assert.deepEqual(x.f.sql.prepare('SELECT * FROM publisher_jobs').all(),before);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_source_import_receipts').get().n,1);
});
test('revocation after source read but before first batch rolls back source head, attempt and review link',async t=>{
 const x=await canonicalFixture(t),base=x.f.db.batch;let changed=false;x.f.db.batch=async ss=>{if(!changed&&ss.some(s=>s.query.startsWith('INSERT INTO sites_source_heads'))){changed=true;const second=new DatabaseSync(x.path);try{second.prepare("UPDATE sites_project_memberships SET revoked_at='2026-10-22T08:00:00.000Z'").run();}finally{second.close();}}return base(ss);};await assert.rejects(ingest(x),/SCOPE_DENIED/);for(const table of ['sites_source_heads','sites_source_attempts','sites_review_sources','sites_reviews'])assert.equal(x.f.sql.prepare('SELECT count(*) n FROM '+table).get().n,0);assert.equal(x.state.reads.length,0);
});
test('newer QA withdrawal during old media read cannot be overwritten by late import completion',async t=>{
 const x=await canonicalFixture(t),original=x.provider.inspect;let release,started;const held=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});x.provider.inspect=async d=>{started();await gate;return original(d);};const old=ingest(x);await held;x.advance(m=>{m.qa_status='MOBILE_READABILITY_RETEST_PENDING';});assert.equal((await ingest(x)).status,'QA_BLOCKED');release();await assert.rejects(old,/CHECK constraint/);
 const head=x.f.sql.prepare('SELECT * FROM sites_source_heads').get();assert.equal(head.source_revision,2);assert.equal(head.state,'QA_BLOCKED');const row=x.f.sql.prepare('SELECT id FROM sites_reviews').get();assert.ok(row);assert.equal((await new AsyncApprovalStore(x.f.db,x.options).view(row.id,x.scope)).can_decide,false);
});
test('missing trusted provider, mutable descriptors, batch budget, and Unicode full slug fail safely or preserve identity',async t=>{
 const x=await canonicalFixture(t,{slug:'贸易与许可-074'});await assert.rejects(new AsyncSourceImport(x.f.db,x.options).import(x.reference()),/SOURCE_PROVIDER_UNAVAILABLE/);const d=await x.inspector.describe(x.reference());d.files[1].sha256='a'.repeat(64);await assert.rejects(x.inspector.inspect(d),/SOURCE_DESCRIPTION_CHANGED/);assert.equal(x.state.reads.length,0);
 const r=await ingest(x);assert.equal(r.status,'REVIEW_REQUIRED');x.advance(m=>{m.primary_image_bytes=17*1024*1024;});const reads=x.state.reads.length;assert.equal((await ingest(x)).reason,'SOURCE_FILE_CONTRACT_INVALID');assert.equal(x.state.reads.length,reads);
});

test('identified manifest removes full content identity: retained source observation blocks old approval',async t=>{
 const x=await canonicalFixture(t),old=await approved(x);x.advance();x.state.raw=Buffer.from(JSON.stringify({project_id:x.binding.project_id,items:[]}));const r=await ingest(x);assert.equal(r.reason,'SOURCE_CONTENT_AMBIGUOUS');assert.equal((await old.approvals.view(old.id,x.scope)).state,'REVOKED');assert.equal(x.f.sql.prepare('SELECT state FROM sites_source_heads').get().state,'FAILED');
});

test('explicit crash reconciliation completes durable Review without re-fetch/inspection; missing Review remains pending',async t=>{
 const x=await canonicalFixture(t),base=x.f.db.batch;let died=false;x.f.db.batch=async ss=>{if(died||ss.some(s=>s.query.startsWith('INSERT INTO sites_source_import_receipts'))){died=true;throw Error('SYNTHETIC_PROCESS_EXIT');}return base(ss);};await assert.rejects(ingest(x),/SYNTHETIC_PROCESS_EXIT/);assert.equal(x.f.sql.prepare('SELECT state FROM sites_source_heads').get().state,'READING');await assert.rejects(ingest(x),/SOURCE_IMPORT_RECONCILE_PENDING/);
 const reads=x.state.reads.length,other=cloudD1Fixture(x.path,{initialize:false});try{const restored=new AsyncSourceImport(other.db,{...x.options,provider:{describe:x.provider.describe,inspect:async()=>{throw Error('MUST_NOT_INSPECT');}}});assert.equal((await restored.reconcile(x.reference())).status,'REVIEW_REQUIRED');}finally{other.close();}assert.equal(x.state.reads.length,reads);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_source_import_receipts').get().n,1);
 const y=await canonicalFixture(t,{contentId:'SYNTHETIC-20261022-075'}),write=y.f.db.batch;let first=true;y.f.db.batch=async ss=>{const r=await write(ss);if(first&&ss.some(s=>s.query.startsWith('INSERT INTO sites_source_heads'))){first=false;throw Error('SYNTHETIC_INITIAL_ACK_LOST');}return r;};await assert.rejects(ingest(y),/SYNTHETIC_INITIAL_ACK_LOST/);await assert.rejects(y.imports.reconcile(y.reference()),/SOURCE_IMPORT_RECONCILE_PENDING/);assert.equal(y.state.reads.length,0);assert.equal(y.f.sql.prepare('SELECT state FROM sites_source_heads').get().state,'READING');
});
