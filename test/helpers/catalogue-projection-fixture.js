import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../../src/store.js';
import {UnifiedPublisher} from '../../src/unified-publisher.js';
import {GroupLibrary} from '../../src/library.js';
import {createApp} from '../../src/server.js';
import {createControlledApp} from '../../maintenance/controlled-app.mjs';
import {image} from './manual-sync-fixture.js';

export async function catalogueFixture(t,{large=false}={}){
 const root=mkdtempSync(join(tmpdir(),'catalogue-projection-')),source=join(root,'enterprise'),otherRoot=join(root,'clients/other'),frozen=join(root,'frozen'),dbPath=join(root,'fixture.sqlite');for(const dir of [source,otherRoot])mkdirSync(dir,{recursive:true});
 const store=new Store(dbPath,{seedDemo:false}),publisher=new UnifiedPublisher(store);store.put('workspaces',{id:'ws-vietbridge',name:'Fixture enterprise',brand:'Fixture',library_kind:'enterprise',content_root:root});const ws='ws-vietbridge',other=store.saveWorkspace({name:'Fixture other',content_root:otherRoot}),files={},platforms=['facebook','xiaohongshu','wechat_official_account','wechat_channels'];
 const cover=join(source,'cover.png'),gallery=join(source,'gallery.png'),video=join(source,'movie.mp4');writeFileSync(cover,image);writeFileSync(gallery,image);writeFileSync(video,Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50]));
 for(const platform of platforms){files[platform]=join(source,platform+'.txt');writeFileSync(files[platform],(platform==='wechat_official_account'?'# Fixture WeChat\n\n':'Fixture title\n\n')+('Complete '+platform+' approved body.\nSecond paragraph with “quotes” and 中文.\n')+(large&&platform==='wechat_official_account'?'Large original detail. '.repeat(30000):'')+(platform==='wechat_channels'?'\n#Fixture':''));}
 const pkg={articleId:'FIXTURE-001',version:'v1',title:'Fixture title',contentType:'image_text',packageRoot:source,readiness:'READY',payloads:files,assets:[{assetId:'cover',path:cover,role:'cover',ordinal:0},{assetId:'gallery',path:gallery,role:'gallery_image',ordinal:1},{assetId:'video',path:video,role:'video',ordinal:2}],variantAssets:{facebook:['cover','gallery'],xiaohongshu:['cover','gallery'],wechat_official_account:['cover'],wechat_channels:['video']},variantAssetRoles:{facebook:[{role:'cover'},{role:'gallery_image'}],xiaohongshu:[{role:'cover'},{role:'gallery_image'}],wechat_official_account:[{role:'cover'}],wechat_channels:[{role:'video'}]}};
 writeFileSync(join(otherRoot,'caption.md'),'---\npublish_title: Other fixture\npublish_caption: Complete OTHER customer text.\n---\n# Internal');writeFileSync(join(otherRoot,'cover.png'),image);writeFileSync(join(otherRoot,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[{content_id:'OTHER-001',status:'READY',body_source:'caption.md',primary_image:'cover.png'}]}));
 const index={index:()=>[pkg]},libraryOptions={roots:[root],snapshotRoot:frozen,gptInboxBase:null,library:index},library=new GroupLibrary(store,libraryOptions),cloud={mode:'mac-tunnel',executionConnected:true,host:'fixture.invalid',origin:'https://fixture.invalid',user:'fixture',password:'disposable-catalogue-password',dataDir:root,accessFile:join(root,'access.json')};let calls=0;
 const server=createControlledApp(createApp,dbPath,{config:{version:1,mode:'READ_ONLY'},head:'a'.repeat(40),cloud,library:libraryOptions,executionEnabled:false,scanScheduler:false,contentSync:{sources:[],automatic:false},drivers:{create:async()=>{calls++;throw Error('No platform operation allowed');}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const login=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cloud.user,password:cloud.password}),redirect:'manual'});if(login.status!==303)throw Error('Fixture login failed');const cookie=login.headers.get('set-cookie').split(';')[0],state=await(await fetch(origin+'/api/state?workspace='+ws,{headers:{cookie}})).json();
 let closed=false;const cleanup=async()=>{if(closed)return;closed=true;await new Promise(r=>{server.once('storage-closed',r);server.close();});store.close();rmSync(root,{recursive:true,force:true});};t?.after(cleanup);
 const get=path=>fetch(origin+path,{headers:{cookie}}),post=(path,body)=>fetch(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-local-token':state.token},body:JSON.stringify(body)});
 return {root,source,otherRoot,frozen,dbPath,store,publisher,ws,other:other.id,files,pkg,cover,gallery,video,library,server,origin,cloud,get,post,calls:()=>calls,cleanup};
}
