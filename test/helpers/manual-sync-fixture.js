import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../../src/store.js';
import {UnifiedPublisher} from '../../src/unified-publisher.js';
import {GroupLibrary} from '../../src/library.js';
import {ContentSync} from '../../src/content-sync.js';
import {createApp} from '../../src/server.js';
import {createControlledApp} from '../../maintenance/controlled-app.mjs';
import {PublisherAccess} from '../../src/publisher-access.js';

export const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQzFsAAAHLAShOgeeRAAAAAElFTkSuQmCC','base64');
export function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'manual-source-fixture-')),client=join(root,'clients','fixture');mkdirSync(client,{recursive:true});
 const dbPath=join(root,'fixture.sqlite'),store=new Store(dbPath,{seedDemo:false}),publisher=new UnifiedPublisher(store),ws=store.saveWorkspace({name:'Fixture',content_root:client}),profile=store.saveProfile(ws.id,{name:'Unused',cdp_port:59994,user_data_dir:join(root,'unused')}),account=publisher.saveAccount(ws.id,{profile_id:profile.id,display_name:'Fixture',expected_identity:'Fixture',identity_type:'PAGE',external_id:'123456',operator_actor_id:'123456',target_page_id:'654321'}),library=new GroupLibrary(store,{roots:[root],snapshotRoot:join(root,'frozen'),gptInboxBase:null});
 const source={projectId:'PROJECT-001',workspaceId:ws.id,manifestDriveFileId:'fixture-manifest',relativeRoot:'clients/fixture'},manifest={project_id:source.projectId,workspace:'independent-client',status:'READY',manifest_revision:1,items:[]},files=new Map();let calls=0,submissions=0;
 const makeClient=async()=>({downloadRaw:async id=>{calls++;if(id===source.manifestDriveFileId)return Buffer.from(JSON.stringify(manifest));if(!files.has(id))throw Error('private fixture network detail');return files.get(id);}});
 const sync=new ContentSync(store,library,{sources:[source],makeClient});
 const cloud={mode:'mac-tunnel',executionConnected:true,host:'publisher.vietbridge.one',origin:'https://publisher.vietbridge.one',user:'fixture',password:'disposable-manual-source-password',dataDir:root,accessFile:join(root,'access.json')};
 const now=Date.now(),authorization={version:1,operation:'SYNC_EXISTING_DRIVE_SOURCE_ONCE',id:'fixture-source-once',issued_at:now-1000,expires_at:now+3600000,approval_thread_id:'fixture-approval-thread',approval_message_id:'fixture-original-message',scope:{workspace:ws.id,account_id:account.id,project_id:source.projectId,manifest_drive_file_id:source.manifestDriveFileId,relative_root:source.relativeRoot,source_root:client}};
 const mounted=[];
 function add(id,body){const b=id+'-body',i=id+'-image';files.set(b,Buffer.from('---\npublish_caption: '+body+'\n---\n# Fixture'));files.set(i,image);const item={content_id:id,status:'READY',body_source:'READY/content/'+id+'.md',content_drive_file_id:b,primary_image:'READY/assets/'+id+'.png',primary_image_drive_file_id:i,primary_image_sha256:createHash('sha256').update(image).digest('hex')};manifest.items.push(item);return item;}
 async function mount({policy=authorization,options={},sources=[source],factory=makeClient}={}){
  const config={version:1,mode:'READ_ONLY',...(policy?{manualContentSync:policy}:{})};
  const server=createControlledApp(createApp,dbPath,{config,head:'a'.repeat(40),cloud,library:{roots:[root],gptInboxBase:null},drivers:{create:async()=>{submissions++;throw Error('FORBIDDEN_PLATFORM_DRIVER');}},executionEnabled:true,scanScheduler:true,contentSync:{sources,makeClient:factory,automatic:true},...options});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const basic='Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64');
  const headers={authorization:basic},state=await(await fetch(origin+'/api/state?workspace='+ws.id,{headers})).json();
  const close=async()=>{if(!server.listening)return;await new Promise(r=>{server.once('storage-closed',r);server.close();});};mounted.push(close);
  return {server,origin,basic,close,get:path=>fetch(origin+path,{headers}),post:(path,input={workspace:ws.id,account_id:account.id},extra={})=>fetch(origin+path,{method:'POST',headers:{...headers,origin,'content-type':'application/json','x-local-token':state.token,...extra},body:JSON.stringify(input)}),appToken:()=>{const a=new PublisherAccess(cloud);return a.createToken({name:'fixture-read-app',password:cloud.password,workspaces:[ws.id],scopes:['jobs:read'],days:1}).token;}};
 }
 t.after(async()=>{for(const close of mounted)await close();await sync.stop();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,client,dbPath,store,publisher,ws,profile,account,library,sync,source,manifest,files,cloud,authorization,add,mount,makeClient,calls:()=>calls,submissions:()=>submissions};
}
