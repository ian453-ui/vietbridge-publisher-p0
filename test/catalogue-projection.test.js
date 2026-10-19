import test from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
import {catalogueFixture} from './helpers/catalogue-projection-fixture.js';
import {GroupLibrary} from '../src/library.js';
const wire=value=>JSON.parse(JSON.stringify(value));

test('enterprise summary is small, searches full body, and opens only the exact current detail',async t=>{
 const f=await catalogueFixture(t),base='/api/group-library?workspace='+f.ws;
 const full=await(await f.get(base)).text(),response=await f.get(base+'&view=summary'),raw=await response.text(),summary=JSON.parse(raw);
 assert.equal(response.status,200);assert.equal(summary.total,1);assert.equal(summary.matched,1);assert.equal(summary.items[0].assetCount,2);
 assert.equal('body' in summary.items[0],false);assert.equal('assets' in summary.items[0],false);
 assert.ok(Buffer.byteLength(raw)<Buffer.byteLength(full)/2);
 const match=await(await f.get(base+'&view=summary&q=Second%20paragraph')).json();assert.equal(match.matched,1);
 const absent=await(await f.get(base+'&view=summary&q=absent')).json();assert.equal(absent.total,1);assert.equal(absent.matched,0);
 const selected=summary.items[0],detail=await(await f.get(base+'&view=detail&key='+selected.key+'&revision='+selected.revision)).json();
 assert.match(detail.item.body,/Second paragraph/);assert.equal(detail.item.assets.length,2);
 assert.equal((await f.get('/api/group-library?workspace='+f.other+'&view=detail&key='+selected.key+'&revision='+selected.revision)).status,409);
 writeFileSync(f.files.facebook,'Changed title\n\nChanged body.');
 assert.equal((await f.get(base+'&view=detail&key='+selected.key+'&revision='+selected.revision)).status,409);
 assert.equal((await f.post('/api/workspaces/'+f.ws+'/library/import',{selections:[{key:selected.key,revision:selected.revision}]})).status,409);
 assert.equal(f.calls(),0);
});

test('summary polling reuses its short cache while changed media and imports still reject old revisions',async t=>{
 const f=await catalogueFixture(t),first=f.library.catalogueSummary(f.ws),key=first.items[0].key,revision=first.items[0].revision;
 let scans=0;const original=f.library.library.index.bind(f.library.library);t.mock.method(f.library.library,'index',()=>{scans++;return original()});
 assert.equal(f.library.catalogueSummary(f.ws).total,1);assert.equal(scans,0);
 f.library.catalogueSummary(f.ws,'',true);assert.equal(scans,1);
 writeFileSync(f.cover,Buffer.from('changed image bytes'));
 assert.throws(()=>f.library.media(f.ws,key,0,revision),/版本已变化/);
 assert.equal((await f.post('/api/workspaces/'+f.ws+'/library/import',{selections:[{key,revision}]})).status,409);
});

test('HTTP catalogue removes only unused platform payloads; all text/media/revision/query fields and internal source remain intact',async t=>{
 const f=await catalogueFixture(t,{large:true}),full=f.library.catalogue(f.ws),response=await f.get('/api/group-library?workspace='+f.ws),raw=await response.text(),items=JSON.parse(raw).items;
 assert.equal(response.status,200);assert.equal(items.length,1);const {platformPayloads,...expected}=full[0];assert.deepEqual(items[0],wire(expected));assert.ok(!('platformPayloads' in items[0]));assert.match(items[0].body,/Second paragraph with “quotes” and 中文/);assert.equal(items[0].assets.length,2);assert.equal(Buffer.byteLength(raw)<Buffer.byteLength(JSON.stringify({items:full}))/4,true);
 assert.deepEqual(f.library.items(f.ws)[0].platformPayloads,platformPayloads,'wire projection cannot mutate internal source');const filtered=await(await f.get('/api/group-library?workspace='+f.ws+'&q=Second')).json();assert.equal(filtered.items[0].key,items[0].key);assert.equal((await(await f.get('/api/group-library?workspace='+f.ws+'&q=absent')).json()).items.length,0);assert.equal(f.calls(),0);
});

test('projected HTTP selection imports all original platform variants and exposes complete platform previews, not the catalogue default',async t=>{
 const f=await catalogueFixture(t),item=(await(await f.get('/api/group-library?workspace='+f.ws)).json()).items[0],original=f.library.items(f.ws)[0].platformPayloads,result=await f.post('/api/workspaces/'+f.ws+'/library/import',{selections:[{key:item.key,revision:item.revision}]});assert.equal(result.status,201,await result.clone().text());const content=(await result.json()).contents[0],variants=f.publisher.contentVariants(content.id);
 assert.deepEqual(Object.keys(variants).sort(),Object.keys(original).sort());for(const [platform,payload] of Object.entries(original)){assert.equal(variants[platform].body,payload.body);assert.equal(variants[platform].title,payload.title);assert.deepEqual(variants[platform].tags,payload.tags);assert.equal(variants[platform].media.length,payload.media.length);for(const [i,path] of variants[platform].media.entries())assert.deepEqual(readFileSync(path),readFileSync(payload.media[i]));}
 const provenance=JSON.parse(f.store.db.prepare('SELECT source_json FROM group_library_imports WHERE content_id=?').get(content.id).source_json).platform_provenance;for(const platform of Object.keys(original))assert.equal(provenance[platform].sourceHash,original[platform].sourceProof.sourceHash);
 const view=await(await f.get('/api/facebook?workspace='+f.ws)).json(),shared=view.groupContent.find(c=>c.id===content.id);assert.deepEqual(shared.platform_payloads,variants);assert.match(shared.platform_payloads.xiaohongshu.body,/xiaohongshu approved body/);assert.match(shared.platform_payloads.wechat_channels.body,/wechat_channels approved body/);assert.equal(f.calls(),0);
});

test('new catalogue revision cannot reuse an old selection or rewrite frozen content and tasks; other workspace cannot borrow key/media',async t=>{
 const f=await catalogueFixture(t),old=(await(await f.get('/api/group-library?workspace='+f.ws)).json()).items[0],created=await f.post('/api/workspaces/'+f.ws+'/library/import',{selections:[{key:old.key,revision:old.revision}]});const content=(await created.json()).contents[0],account=f.publisher.saveAccount(f.ws,{platform:'xiaohongshu',display_name:'Fixture XHS',external_id:'username:Fixture XHS'}),job=f.publisher.createPageJob(f.ws,{account_id:account.id,content_id:content.id}),before=f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(job.id),variants=f.publisher.contentVariants(content.id);
 writeFileSync(f.files.xiaohongshu,'New title\n\nNew complete XHS revision.');const next=(await(await f.get('/api/group-library?workspace='+f.ws+'&refresh=1')).json()).items[0];assert.equal(next.key,old.key);assert.notEqual(next.revision,old.revision);assert.equal((await f.post('/api/workspaces/'+f.ws+'/library/import',{selections:[{key:old.key,revision:old.revision}]})).status,409);assert.deepEqual(f.publisher.contentVariants(content.id),variants);assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(job.id),before);
 const other=(await(await f.get('/api/group-library?workspace='+f.other)).json()).items;assert.ok(other.every(i=>i.key!==old.key&&!i.body.includes('xiaohongshu')));assert.equal((await f.post('/api/workspaces/'+f.other+'/library/import',{selections:[{key:next.key,revision:next.revision}]})).status,409);assert.equal((await f.get('/api/group-library/media?workspace='+f.other+'&key='+next.key+'&revision='+next.revision+'&index=0')).status,409);assert.equal(f.calls(),0);
});

test('HTTP projection preserves GPT old/new review bodies and unknown display metadata without mutating catalogue records',async t=>{
 const f=await catalogueFixture(t),row={key:'pending',revision:'new-r',articleId:'SAME-001',body:'Complete NEW reviewed text.',assets:[],reviewStatus:'UPDATE_AVAILABLE',previousRevision:'old-r',previousVersion:{body:'Complete OLD frozen text.',title:'Old title',contentRevision:1,visualRevision:7,imageHash:'old-hash'},contentRevision:2,visualRevision:8,ready:false,blockingReason:'Review required',futureDisplay:{label:'Preserve'},platformPayloads:{facebook:{body:'Internal variant'}}};t.mock.method(GroupLibrary.prototype,'catalogue',()=>[row]);const items=(await(await f.get('/api/group-library?workspace='+f.ws)).json()).items;const {platformPayloads,...rest}=row;assert.deepEqual(items[0],rest);assert.deepEqual(row.platformPayloads,platformPayloads);assert.equal(f.calls(),0);
});
