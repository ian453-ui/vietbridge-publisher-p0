import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContentLibrary} from '../src/publisher-core/content-library.ts';
import {Store} from '../src/store.js';
import {GroupLibrary} from '../src/library.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {publisherPayload} from '../src/publisher-form-state.js';
const platforms=['facebook','xiaohongshu','wechat_official_account','wechat_channels'];
const names={facebook:'facebook-video-public.txt',xiaohongshu:'xiaohongshu-video-public.txt',wechat_official_account:'wechat-public.md',wechat_channels:'wechat-channels-public.txt'};
for(const media of ['image','video'])for(const source of platforms)test(`real library ${source}-only ${media} cannot become another platform copy`,()=>{
 const root=mkdtempSync(join(tmpdir(),'platform-copy-')),store=new Store(join(root,'db.sqlite'),{seedDemo:false});
 try{
 store.put('workspaces',{id:'ws-vietbridge',name:'Fixture',brand:'Fixture',library_kind:'enterprise',channels:[]});
 writeFileSync(join(root,'Daily-901-'+names[source]),'Approved source title\n\nONLY '+source+' APPROVED BODY');writeFileSync(join(root,'Daily-901-'+(media==='video'?'video.mp4':'cover_QA_PASS.png')),'fixture asset bytes');
 const library=new ContentLibrary({roots:[root]}),[indexed]=library.index();assert.ok(indexed);assert.deepEqual(Object.keys(indexed.payloads),[source]);assert.equal(existsSync(join(root,'.publisher-captions')),false);
 const bridge=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'frozen'),library,gptInboxBase:null}),[item]=bridge.catalogue('ws-vietbridge');assert.equal(item.ready,true);const [content]=bridge.import('ws-vietbridge',[{key:item.key,revision:item.revision}]);
 const pub=new UnifiedPublisher(store),hydrated={...content,library_source:{article_id:item.articleId},platform_payloads:pub.contentVariants(content.id)};
 for(const target of platforms.filter(p=>p!==source)){
 const profile=store.saveProfile('ws-vietbridge',{name:'Fixture '+target,cdp_port:59990+platforms.indexOf(target),user_data_dir:join(root,'profile-'+target)});
 assert.match(publisherPayload(hydrated,target,{body:'attempted override'}).blockedReason,/尚无该平台公开文案/);assert.equal(publisherPayload(hydrated,target).body,'');
 const config=join(root,'config.json');writeFileSync(config,'{}',{mode:0o600});const account=pub.saveAccount('ws-vietbridge',{platform:target,display_name:target,expected_identity:target,external_id:target==='facebook'?'123456':target==='wechat_official_account'?'wx1234567890abcdef':target==='xiaohongshu'?'username:Fixture':'sph-fixture',operator_actor_id:'123456',target_page_id:'654321',identity_type:'PAGE',profile_id:profile.id,config_url:target==='wechat_official_account'?config:undefined});
 assert.throws(()=>pub.createPageJob('ws-vietbridge',{account_id:account.id,content_id:content.id,payload:{body:'attempted override'}}),/尚无该平台公开文案/);
 }
 assert.equal(store.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('explicit public-payloads shared caption remains available; script-only video cannot invent copy',()=>{
 const root=mkdtempSync(join(tmpdir(),'shared-caption-'));
 try{mkdirSync(join(root,'public-payloads'));writeFileSync(join(root,'public-payloads','Daily-902.txt'),'Explicit shared public caption');writeFileSync(join(root,'Daily-902-video.mp4'),'fixture video');writeFileSync(join(root,'Daily-903-video.mp4'),'fixture video');writeFileSync(join(root,'Daily-903-script.txt'),'Internal opening cannot authorize publication');
 const items=new ContentLibrary({roots:[root]}).index(),shared=items.find(p=>p.articleId==='Daily-902'),script=items.find(p=>p.articleId==='Daily-903');assert.ok(shared);assert.deepEqual(Object.keys(shared.payloads).sort(),['facebook','wechat_channels','xiaohongshu']);assert.ok(script);assert.deepEqual(script.payloads,{});assert.equal(script.readiness,'BLOCKED');assert.equal(existsSync(join(root,'.publisher-captions')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('claim refuses missing target copy even for an existing pre-gate task',()=>{
 const root=mkdtempSync(join(tmpdir(),'claim-copy-')),store=new Store(join(root,'db.sqlite'),{seedDemo:false});try{
 const image=join(root,'cover.png');writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));const ws=store.saveWorkspace({name:'Fixture'}),pub=new UnifiedPublisher(store),profile=store.saveProfile(ws.id,{name:'Fixture',cdp_port:59999,user_data_dir:join(root,'profile')}),account=pub.saveAccount(ws.id,{platform:'xiaohongshu',display_name:'Fixture',external_id:'username:Fixture',profile_id:profile.id}),content=pub.importContent(ws.id,{source_id:'old',revision:'1',title:'Approved title',body:'Old pre-gate copy',media:[image]}),job=pub.createPageJob(ws.id,{account_id:account.id,content_id:content.id});
 const executor=new UnifiedExecutor(pub,{enabled:true,mediaRoots:[root],snapshotRoot:join(root,'media'),drivers:{create:()=>{throw Error('never connect');}}});executor.approve(ws.id,job.id,job.snapshot_hash);
 // Simulate an already stored legacy import with no target approval, before claim.
 new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'frozen'),gptInboxBase:null});store.db.prepare('INSERT INTO group_library_imports VALUES(?,?,?,?,?,?,?)').run(content.id,ws.id,'old','v1',root,'fixture','{}');
 assert.throws(()=>executor.claim(ws.id,job.id),/尚无该平台公开文案/);assert.equal(pub.job(ws.id,job.id).state,'READY');assert.equal(pub.job(ws.id,job.id).attempt_id,null);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
