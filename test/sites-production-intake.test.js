import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {normalizeLeadUrl,unconfiguredProductionProvider} from '../src/sites/async-production-intake.js';

function setup(t){const root=mkdtempSync(join(tmpdir(),'v3-production-intake-')),path=join(root,'db.sqlite'),f=cloudD1Fixture(path);t.after(()=>{f.close();rmSync(root,{recursive:true,force:true});});return Object.assign(f,{path});}
async function workspace(f,name){return (await f.call('/api/sites/workspaces',{command_id:crypto.randomUUID(),name})).body.id;}
const lead=(overrides={})=>({command_id:crypto.randomUUID(),source_kind:'URL',url:'https://example.org/article?id=092&utm_source=chat#summary',title:'Synthetic source',brief:'Untrusted research lead; no article generated.',connector_id:'MANUAL_UI',event_id:crypto.randomUUID(),parent_lead_id:null,...overrides});
const base=w=>'/api/sites/workspaces/'+w+'/production';

test('lead URL normalization is identity-only and blocks local/credential URLs without fetching',()=>{
 assert.equal(normalizeLeadUrl('HTTPS://Example.ORG:443/article?id=092&utm_source=x#note'),'https://example.org/article?id=092');
 assert.throws(()=>normalizeLeadUrl('http://127.0.0.1/private'),/UNSAFE_SOURCE_HOST/);
 assert.throws(()=>normalizeLeadUrl('https://user:pass@example.org/article'),/INVALID_SOURCE_URL/);
 assert.throws(()=>normalizeLeadUrl('file:///etc/passwd'),/INVALID_SOURCE_URL/);
 assert.equal(unconfiguredProductionProvider.configured,false);
});

test('workspace-scoped event receipt is idempotent; same URL can still start a new lineage',async t=>{
 const f=setup(t),w=await workspace(f,'Synthetic A'),other=await workspace(f,'Synthetic B'),input=lead(),first=await f.call(base(w)+'/leads',input);
 assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.job.state,'WAITING_PROVIDER');assert.equal(first.body.job.provider_state,'UNCONFIGURED');assert.equal(first.body.job.qa_state,'BLOCKED');assert.equal(first.body.publish_allowed,false);
 assert.equal(first.body.job.canonical_url,'https://example.org/article?id=092');assert.equal(first.body.job.rights_status,'UNVERIFIED');
 const repeat=await f.call(base(w)+'/leads',{...input,command_id:crypto.randomUUID()});assert.equal(repeat.body.job.id,first.body.job.id);assert.equal(repeat.body.duplicate,true);
 assert.equal((await f.call(base(w)+'/leads',{...input,title:'Conflicting same event',command_id:crypto.randomUUID()})).body.error,'PRODUCTION_EVENT_CONFLICT');
 const next=await f.call(base(w)+'/leads',{...input,command_id:crypto.randomUUID(),event_id:crypto.randomUUID(),parent_lead_id:first.body.job.lead_id});assert.equal(next.status,200,JSON.stringify(next.body));assert.notEqual(next.body.job.id,first.body.job.id);assert.equal(next.body.job.parent_lead_id,first.body.job.lead_id);assert.equal(next.body.duplicate_candidates[0].id,first.body.job.lead_id);
 assert.equal((await f.call(base(w)+'/jobs')).body.jobs.length,2);assert.equal((await f.call(base(other)+'/jobs')).body.jobs.length,0);
 assert.equal((await f.call(base(other)+'/jobs/'+first.body.job.id)).status,404);assert.equal((await f.call(base(other)+'/leads',{...input,parent_lead_id:first.body.job.lead_id,event_id:crypto.randomUUID()})).body.error,'PARENT_LEAD_NOT_FOUND');
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_jobs').get().n,2);
});

test('a duplicate event binds its new command to the exact normalized request and original result',async t=>{
 const f=setup(t),w=await workspace(f,'Synthetic duplicate receipt'),original=lead({event_id:'source-event-1'}),first=await f.call(base(w)+'/leads',original);assert.equal(first.status,200);
 const command=crypto.randomUUID(),replay={...original,command_id:command,url:'https://example.org/article?id=092&utm_campaign=replay'};
 f.fault=1;const rolledBack=await f.call(base(w)+'/leads',replay);assert.equal(rolledBack.status,409);f.fault=-1;assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_commands WHERE command_id=?').get(command).n,0);
 const sameEvent=await f.call(base(w)+'/leads',replay);assert.equal(sameEvent.status,200);assert.equal(sameEvent.body.job.id,first.body.job.id);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_commands WHERE command_id=? AND lead_id=? AND applied=1').get(command,first.body.job.lead_id).n,1);
 assert.equal((await f.call(base(w)+'/leads',{...replay,url:'https://example.org/article?id=092&utm_medium=another'})).body.job.id,first.body.job.id);
 const changedEvent=await f.call(base(w)+'/leads',{...replay,event_id:'source-event-2'});assert.equal(changedEvent.status,409);assert.equal(changedEvent.body.error,'COMMAND_CONFLICT');
 assert.equal((await f.call(base(w)+'/leads',replay)).body.job.id,first.body.job.id);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_leads').get().n,1);
});

test('production command receipt is an owner-scoped read, never a new create',async t=>{
 const f=setup(t),w=await workspace(f,'Receipt owner'),other=await workspace(f,'Other workspace'),input=lead(),missing=await f.call(base(w)+'/commands/'+input.command_id);assert.deepEqual(missing.body,{outcome:'NO_RECEIPT',publish_allowed:false});
 const created=await f.call(base(w)+'/leads',input),receipt=await f.call(base(w)+'/commands/'+input.command_id);assert.equal(created.status,200);assert.equal(receipt.status,200);assert.equal(receipt.body.outcome,'COMMITTED');assert.equal(receipt.body.job_id,created.body.job.id);assert.equal(receipt.body.created_state,'WAITING_PROVIDER');
 assert.equal((await f.call(base(other)+'/commands/'+input.command_id)).body.outcome,'NO_RECEIPT');f.user='different-owner';assert.equal((await f.call(base(w)+'/commands/'+input.command_id)).status,403);f.user='synthetic-owner';
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_leads').get().n,1);
});

test('manual lead and pause/resume/cancel use durable exact commands and forbid handoff',async t=>{
 const f=setup(t),w=await workspace(f,'Synthetic A'),input=lead({source_kind:'MANUAL',url:null,title:'Manual synthetic tip',brief:'No verified source.\nSecond line remains a tip, not an instruction.',event_id:'manual-1'}),created=await f.call(base(w)+'/leads',input);assert.equal(created.status,200,JSON.stringify(created.body));const id=created.body.job.id;assert.equal(created.body.job.brief,input.brief);
 const check=await f.call(base(w)+'/jobs/'+id+'/handoff-check');assert.equal(check.status,200);assert.equal(check.body.eligible,false);assert.ok(check.body.blockers.includes('IMAGE_MISSING'));
 assert.equal((await f.call(base(w)+'/jobs/'+id+'/handoff',{command_id:crypto.randomUUID()})).body.error,'PRODUCTION_HANDOFF_BLOCKED');
 const pause={command_id:crypto.randomUUID(),action:'PAUSE',expected_revision:1},paused=await f.call(base(w)+'/jobs/'+id+'/actions',pause);assert.equal(paused.status,200,JSON.stringify(paused.body));assert.equal(paused.body.receipt.state,'PAUSED');assert.equal(paused.body.job.revision,2);
 const repeated=await f.call(base(w)+'/jobs/'+id+'/actions',pause);assert.equal(repeated.body.duplicate,true);assert.deepEqual(repeated.body.receipt,paused.body.receipt);
 assert.equal((await f.call(base(w)+'/jobs/'+id+'/actions',{...pause,action:'CANCEL'})).body.error,'COMMAND_CONFLICT');
 assert.equal((await f.call(base(w)+'/jobs/'+id+'/actions',{command_id:crypto.randomUUID(),action:'RESUME',expected_revision:1})).body.error,'PRODUCTION_STATE_CONFLICT');
 const resumed=await f.call(base(w)+'/jobs/'+id+'/actions',{command_id:crypto.randomUUID(),action:'RESUME',expected_revision:2});assert.equal(resumed.body.job.state,'WAITING_PROVIDER');
 const cancelled=await f.call(base(w)+'/jobs/'+id+'/actions',{command_id:crypto.randomUUID(),action:'CANCEL',expected_revision:3});assert.equal(cancelled.body.job.state,'CANCELLED');assert.equal((await f.call(base(w)+'/jobs/'+id+'/handoff-check')).body.blockers[0],'PRODUCTION_CANCELLED');
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_contents').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
});

test('lost create acknowledgement, failed atomic batch, owner change and origin guard fail closed',async t=>{
 const f=setup(t),w=await workspace(f,'Synthetic A'),input=lead({event_id:'lost-ack'}),first=await f.call(base(w)+'/leads',input);assert.equal(first.status,200);
 // Simulate a committed request whose HTTP acknowledgement was lost.
 const readback=await f.call(base(w)+'/leads',input);assert.equal(readback.body.job.id,first.body.job.id);assert.equal(readback.body.duplicate,true);
 f.fault=2;const failed=await f.call(base(w)+'/leads',lead({event_id:'rolled-back'}));assert.equal(failed.status,409);f.fault=-1;assert.equal(f.sql.prepare("SELECT count(*) n FROM sites_production_leads WHERE event_id='rolled-back'").get().n,0);
 const denied=await f.call(base(w)+'/leads',lead(),{headers:{origin:'https://cross-site.invalid'}});assert.equal(denied.status,403);
 f.user='different-owner';assert.equal((await f.call(base(w)+'/jobs')).status,403);assert.equal((await f.call(base(w)+'/jobs/'+first.body.job.id)).status,403);f.user='synthetic-owner';
 assert.equal((await f.call(base(w)+'/jobs/'+first.body.job.id)).body.job.id,first.body.job.id);
});

test('concurrent duplicate events and a restarted D1-shaped reader preserve one lead',async t=>{
 const f=setup(t),w=await workspace(f,'Synthetic A'),input=lead({event_id:'webhook-event-42',connector_id:'AUTHORIZED_TEST_EVENT'});
 const [a,b]=await Promise.all([f.call(base(w)+'/leads',input),f.call(base(w)+'/leads',{...input,command_id:crypto.randomUUID()})]);assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(b.status,200,JSON.stringify(b.body));assert.equal(a.body.job.id,b.body.job.id);assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_leads').get().n,1);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM sites_production_commands WHERE kind='CREATE' AND applied=1").get().n,2);
 const reopened=cloudD1Fixture(f.path,{initialize:false});t.after(()=>reopened.close());const read=await reopened.call(base(w)+'/jobs/'+a.body.job.id);assert.equal(read.status,200);assert.equal(read.body.job.event_id,'webhook-event-42');assert.equal(read.body.job.state,'WAITING_PROVIDER');
});

test('failed state transition rolls back receipt and remains resumable with the same command',async t=>{
 const f=setup(t),w=await workspace(f,'Synthetic A'),created=(await f.call(base(w)+'/leads',lead())).body,id=created.job.id,command={command_id:crypto.randomUUID(),action:'PAUSE',expected_revision:1};
 f.fault=1;const failed=await f.call(base(w)+'/jobs/'+id+'/actions',command);assert.equal(failed.status,409);f.fault=-1;
 assert.equal((await f.call(base(w)+'/jobs/'+id)).body.job.state,'WAITING_PROVIDER');assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_commands WHERE command_id=?').get(command.command_id).n,0);
 const retry=await f.call(base(w)+'/jobs/'+id+'/actions',command);assert.equal(retry.status,200,JSON.stringify(retry.body));assert.equal(retry.body.job.state,'PAUSED');assert.equal(f.sql.prepare('SELECT count(*) n FROM sites_production_commands WHERE command_id=?').get(command.command_id).n,1);
});
