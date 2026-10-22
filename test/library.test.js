import {UnifiedPublisher} from '../src/unified-publisher.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.js';
import {GroupLibrary} from '../src/library.js';
import {ContentLibrary} from '../src/publisher-core/content-library.ts';
import {image as png} from './helpers/manual-sync-fixture.js';
test('library reuses public payload, freezes bytes, deduplicates imports and creates content × group jobs',()=>{
  const root=mkdtempSync(join(tmpdir(),'v2-library-')),image=join(root,'poster.png');writeFileSync(image,'original media bytes');
  const store=new Store(join(root,'db.sqlite'));
  let body='Facebook 公开正文';const caption=join(root,'Daily-019-facebook-public.txt');writeFileSync(caption,body);
  const library={index:()=>[{articleId:'Daily-019',version:'v1',title:'企业培训',contentType:'image_text',packageRoot:root,assets:[{path:image,role:'gallery_image',ordinal:1}],payloads:{facebook:caption,xiaohongshu:'不要带入小红书文案'},publishedPlatforms:['facebook']}]};
  const bridge=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'frozen'),library});
  try{
    const items=bridge.catalogue('ws-vietbridge');assert.equal(items.length,1);assert.equal(items[0].body,body);
    const firstRevision=items[0].assets[0].revision;assert.match(firstRevision,/^[a-f0-9]{64}$/);
    assert.equal(bridge.catalogue('ws-vietbridge',null).length,1);
    assert.throws(()=>bridge.catalogue('ws-abc'),/尚未配置/);
    const selection={key:items[0].key,revision:items[0].revision};
    const [content]=bridge.import('ws-vietbridge',[selection]);assert.equal(content.body,body);
    assert.equal(bridge.import('ws-vietbridge',[selection])[0].id,content.id);
    const frozen=JSON.parse(content.media_json)[0];writeFileSync(image,'changed media bytes');assert.equal(readFileSync(frozen,'utf8'),'original media bytes');
    assert.equal(bridge.contentMedia('ws-vietbridge',content.id,0).path,frozen);
    assert.throws(()=>bridge.contentMedia('ws-vietbridge',content.id,-1),/媒体不存在/);
    assert.throws(()=>bridge.contentMedia('ws-vietbridge','wrong-content',0),/媒体不存在/);
    const refreshed=bridge.catalogue('ws-vietbridge')[0];assert.notEqual(refreshed.assets[0].revision,firstRevision);assert.notEqual(refreshed.revision,items[0].revision);
    assert.throws(()=>bridge.import('ws-vietbridge',[selection]),/版本已变化/);
    const profile=store.saveProfile('ws-vietbridge',{name:'FB',cdp_port:19325,user_data_dir:join(root,'profile')});
    const account=store.saveAccount('ws-vietbridge',{display_name:'VB',profile_id:profile.id});
    const groups=[1,2].map(i=>store.addGroup('ws-vietbridge',{account_id:account.id,url:'https://www.facebook.com/groups/'+i}));
    const manual=store.createContent('ws-vietbridge',{title:'手工内容',body:'手工正文'});
    const input={account_id:account.id,content_ids:[content.id,manual.id],group_ids:groups.map(g=>g.id)};
    const first=store.createGroupJobs('ws-vietbridge',input);assert.equal(first.length,4);assert.equal(first.filter(j=>j.was_created).length,4);
    const duplicate=store.createGroupJobs('ws-vietbridge',input);assert.equal(duplicate.length,4);assert.equal(duplicate.filter(j=>j.was_created).length,0);
    assert.equal(store.rows('group_jobs','ws-vietbridge').length,4);
    assert.ok(store.rows('group_jobs','ws-vietbridge').every(j=>j.state==='PENDING'));
  }finally{store.close();}
});

test('independent client package stays isolated and visual-only copy cannot be imported',()=>{
  const root=mkdtempSync(join(tmpdir(),'v2-client-library-'));
  const client=join(root,'clients','lp'),content=join(client,'READY','content'),assets=join(client,'READY','assets');
  mkdirSync(content,{recursive:true});mkdirSync(assets,{recursive:true});
  writeFileSync(join(content,'CNVISA-FB-001.md'),'---\ncontent_id: CNVISA-FB-001\n---\n# Visa\nVisual package only. Use the approved Vietnamese Facebook body associated with this content_id.');
  writeFileSync(join(assets,'cover.png'),'cover bytes');writeFileSync(join(assets,'body.png'),'body bytes');
  writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[{content_id:'CNVISA-FB-001',status:'READY',title:'Visa',cover:'READY/assets/cover.png',infographic:'READY/assets/body.png'}]}));
  const store=new Store(join(root,'db.sqlite'));
  try{
    const workspace=store.saveWorkspace({name:'LP',brand:'LP',content_root:client});
    const library=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'snapshots'),library:{index:()=>[]}});
    const [item]=library.catalogue(workspace.id);
    assert.equal(item.ready,false);assert.equal(item.assets.length,2);
    assert.throws(()=>library.import(workspace.id,[{key:item.key,revision:item.revision}]),/缺少已批准/);
    writeFileSync(join(content,'CNVISA-FB-001.md'),'---\ncontent_id: CNVISA-FB-001\n---\n# Visa\nĐây là nội dung Facebook công khai đã duyệt.');
    const [updated]=library.catalogue(workspace.id);
    assert.equal(updated.ready,true);assert.notEqual(updated.revision,item.revision);
    assert.throws(()=>library.catalogue('ws-abc'),/尚未配置/);
  }finally{store.close();}
});

test('client revision 4 selects approved caption and one primary image',()=>{
  const root=mkdtempSync(join(tmpdir(),'v2-client-rev4-'));
  const client=join(root,'clients','lp'),content=join(client,'READY','content'),assets=join(client,'READY','assets');
  mkdirSync(content,{recursive:true});mkdirSync(assets,{recursive:true});
  writeFileSync(join(content,'CNVISA-FB-001.md'),'---\ncontent_id: CNVISA-FB-001\npublish_title: Public title\npublish_caption: |-\n  Approved caption\n  Final CTA\n---\n# Old title\nStale body');
  writeFileSync(join(assets,'primary.png'),'primary bytes');writeFileSync(join(assets,'cover.png'),'old cover');
  writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[{content_id:'CNVISA-FB-001',status:'READY',primary_image:'READY/assets/primary.png',cover:'READY/assets/cover.png'}]}));
  const store=new Store(join(root,'db.sqlite'));
  try{const workspace=store.saveWorkspace({name:'LP',brand:'LP',content_root:client});const library=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'snapshots')});const [item]=library.catalogue(workspace.id);
    assert.equal(item.ready,true);assert.equal(item.body,'Approved caption\nFinal CTA');assert.equal(item.title,'Public title');
    assert.deepEqual(item.assets.map(a=>a.name),['primary.png']);
    const [imported]=library.import(workspace.id,[{key:item.key,revision:item.revision}]);assert.equal(imported.body,item.body);
    assert.deepEqual(JSON.parse(imported.media_json).map(p=>readFileSync(p,'utf8')),['primary bytes']);
  }finally{store.close();}
});

test('GPT Drive submission appears for review and only explicit approval adds it to the publisher library',()=>{
  const root=mkdtempSync(join(tmpdir(),'v2-gpt-inbox-')),client=join(root,'clients','lp'),content=join(client,'READY','content'),assets=join(client,'READY','assets'),inbox=join(client,'GPT-INBOX','draft-001');
  mkdirSync(content,{recursive:true});mkdirSync(assets,{recursive:true});mkdirSync(inbox,{recursive:true});
  writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[]}));
  writeFileSync(join(inbox,'cover.png'),Buffer.concat([png,Buffer.alloc(200,1)]));
  writeFileSync(join(inbox,'submission.json'),JSON.stringify({schema_version:1,status:'READY_FOR_REVIEW',content_id:'LP-FB-011',title:'Travel planning',facebook_caption:'Approved only after review.',primary_image:'cover.png'}));
  const store=new Store(join(root,'db.sqlite'));
  try{const workspace=store.saveWorkspace({name:'LP',brand:'LP',content_root:client}),library=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'snapshots')});
    const [pending]=library.catalogue(workspace.id);assert.equal(pending.reviewStatus,'PENDING_REVIEW');assert.equal(pending.ready,false);
    assert.throws(()=>library.import(workspace.id,[{key:pending.key,revision:pending.revision}]),/待您审核/);
    assert.equal(store.rows('group_jobs',workspace.id).length,0);
    library.approveGpt(workspace.id,pending.key,pending.revision);
    const [approved]=library.catalogue(workspace.id);assert.equal(approved.ready,true);assert.equal(approved.articleId,'LP-FB-011');
    const v1=new ContentLibrary({roots:[root]});assert.equal(v1.index().find(item=>item.articleId==='LP-FB-011')?.readiness,'READY');
    assert.equal(store.rows('group_jobs',workspace.id).length,0);
    assert.equal(library.approveGpt(workspace.id,pending.key,pending.revision).already_applied,true);
  }finally{store.close();}
});

test('rejecting a GPT Drive draft hides only that exact revision and preserves its source',()=>{
  const root=mkdtempSync(join(tmpdir(),'v2-gpt-reject-')),client=join(root,'clients','lp'),content=join(client,'READY','content'),assets=join(client,'READY','assets'),inbox=join(client,'GPT-INBOX','draft-001');
  mkdirSync(content,{recursive:true});mkdirSync(assets,{recursive:true});mkdirSync(inbox,{recursive:true});
  writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[]}));
  const image=Buffer.concat([png,Buffer.alloc(200,7)]),submission=join(inbox,'submission.json'),imagePath=join(inbox,'cover.png');
  writeFileSync(imagePath,image);
  writeFileSync(submission,JSON.stringify({schema_version:1,status:'READY_FOR_REVIEW',content_id:'LP-FB-012',title:'Travel planning',facebook_caption:'Review this draft.',primary_image:'cover.png'}));
  const original=readFileSync(submission,'utf8'),store=new Store(join(root,'db.sqlite'));
  try{
    const workspace=store.saveWorkspace({name:'LP',brand:'LP',content_root:client}),library=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'snapshots')});
    const [pending]=library.catalogue(workspace.id);assert.equal(pending.reviewStatus,'PENDING_REVIEW');
    assert.throws(()=>library.rejectGpt(workspace.id,pending.key,'stale-revision'),/已变化/);
    assert.equal(library.rejectGpt(workspace.id,pending.key,pending.revision).status,'REJECTED');
    assert.equal(library.catalogue(workspace.id,'',true).length,0);
    assert.equal(readFileSync(submission,'utf8'),original);assert.deepEqual(readFileSync(imagePath),image);
    const restarted=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'snapshots')});assert.equal(restarted.catalogue(workspace.id,'',true).length,0);
    writeFileSync(submission,JSON.stringify({schema_version:1,status:'READY_FOR_REVIEW',content_id:'LP-FB-012',revision_number:2,title:'Travel planning',facebook_caption:'Revised draft.',primary_image:'cover.png',primary_image_sha256:createHash('sha256').update(image).digest('hex')}));
    const [newRevision]=restarted.catalogue(workspace.id,'',true);assert.equal(newRevision.reviewStatus,'PENDING_REVIEW');assert.notEqual(newRevision.revision,pending.revision);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace=? AND event='gpt_drive_content_rejected'").get(workspace.id).count,1);
  }finally{store.close();}
});

test('shared catalogue keeps a WeChat-only article and never routes its copy into Facebook page or group publication',()=>{
 const root=mkdtempSync(join(tmpdir(),'wechat-only-catalogue-')),poster=join(root,'cover.png'),copy=join(root,'wechat.md');writeFileSync(poster,Buffer.from([137,80,78,71,13,10,26,10,1]));writeFileSync(copy,'---\ntitle: WeChat public article\n---\n# Full article\nOnly WeChat copy.');
 const store=new Store(join(root,'db.sqlite')),publisher=new UnifiedPublisher(store),library=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'frozen'),library:{index:()=>[{articleId:'WECHAT-ONLY-001',version:'1',title:'Only WeChat',contentType:'image_text',packageRoot:root,readiness:'READY',assets:[{path:poster,role:'cover',ordinal:1}],payloads:{wechat_official_account:copy}}]}});
 try{
  const [item]=library.catalogue('ws-vietbridge');assert.equal(item.articleId,'WECHAT-ONLY-001');assert.equal(item.ready,true);assert.equal(item.defaultPlatform,'wechat_official_account');assert.match(item.body,/Only WeChat copy/);assert.equal(item.platformPayloads.facebook,undefined);const [content]=library.import('ws-vietbridge',[{key:item.key,revision:item.revision}]);assert.match(publisher.contentVariants(content.id).wechat_official_account.body,/Only WeChat copy/);
  const profile=store.saveProfile('ws-vietbridge',{name:'Mock',cdp_port:59991,user_data_dir:join(root,'profile')}),account=publisher.saveAccount('ws-vietbridge',{display_name:'Mock Page',expected_identity:'Mock Page',profile_id:profile.id,identity_type:'PAGE',external_id:'12345',operator_actor_id:'12345',target_page_id:'98765'});assert.throws(()=>publisher.createPageJob('ws-vietbridge',{account_id:account.id,content_id:content.id}),/尚无该平台公开文案/);assert.throws(()=>store.createGroupJobs('ws-vietbridge',{account_id:account.id,content_ids:[content.id],group_ids:['unused']}),/尚无 Facebook 公开文案/);assert.equal(store.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
 }finally{store.close();}
});

test('latest client QA withdrawal overrides READY/title/image PASS across both retained library paths',()=>{
 const root=mkdtempSync(join(tmpdir(),'v3-client-qa-')),client=join(root,'clients','synthetic-qa'),content=join(client,'READY','content'),assets=join(client,'READY','assets'),id='VBE-20261022-062';mkdirSync(content,{recursive:true});mkdirSync(assets,{recursive:true});writeFileSync(join(content,id+'.md'),'# SYNTHETIC QA_PASS\nComplete synthetic public copy.');writeFileSync(join(assets,'cover_QA_PASS.png'),png);
 const manifest={status:'READY',items:[{content_id:id,status:'READY',qa_status:'PASS',title:'SYNTHETIC QA_PASS',primary_image:'READY/assets/cover_QA_PASS.png'}]},path=join(client,'publisher-manifest.json');writeFileSync(path,JSON.stringify(manifest));const store=new Store(join(root,'db.sqlite'));
 try{const ws=store.saveWorkspace({name:'Synthetic QA',brand:'Synthetic',content_root:client}),groups=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'frozen')}),native=new ContentLibrary({roots:[root]}),before=groups.catalogue(ws.id)[0],nativeBefore=native.index().find(x=>x.articleId===id);assert.equal(before.ready,true);assert.equal(nativeBefore.readiness,'READY');
 manifest.items[0].qa_status='MOBILE_READABILITY_RETEST_PENDING';writeFileSync(path,JSON.stringify(manifest));const current=groups.catalogue(ws.id)[0],nativeCurrent=native.index().find(x=>x.articleId===id);
 assert.deepEqual([current.ready,nativeCurrent.readiness],[false,'BLOCKED']);assert.notEqual(current.revision,before.revision);assert.notEqual(nativeCurrent.version,nativeBefore.version);assert.equal(nativeCurrent.assets[0].qaState,'UNKNOWN');assert.throws(()=>groups.import(ws.id,[{key:before.key,revision:before.revision}]),/版本已变化|QA|审核/);
 manifest.items[0].qa_status='PASS';manifest.qa_status='FAIL';writeFileSync(path,JSON.stringify(manifest));assert.equal(groups.catalogue(ws.id)[0].ready,false);assert.equal(native.index().find(x=>x.articleId===id).assets[0].qaState,'FAIL');
 }finally{store.close();}
});
