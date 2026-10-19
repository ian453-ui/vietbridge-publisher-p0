import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../../src/store.js';
import {UnifiedPublisher} from '../../src/unified-publisher.js';

// Public source/DB fixtures only. Never use a real account, profile or credential.
export function legacyFixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'vb-legacy-compat-'))),social=join(root,'Social'),legacyRoot=join(social,'Publisher-P0'),contentRoot=join(social,'Content-Library'),homeDir=join(root,'home'),channelDir=join(homeDir,'.config/vietbridge-social/chrome/wechat-channels');
 for(const directory of [join(legacyRoot,'src'),join(legacyRoot,'data'),contentRoot,channelDir])mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(channelDir,0o700);
 const sources={
  'task-service.ts':'const ACCOUNTS: Record<SupportedPlatform,string> = { xiaohongshu: "username:Fixture XHS", wechat_channels: "sph-fixture-channel" };',
  'wechat-channels-contract.ts':'export const WECHAT_CHANNELS_ACCOUNT = { displayName: "Fixture Channel", accountId: "sph-fixture-channel", collection: "Fixture collection" } as const;',
  'wechat-channels-driver.ts':'readonly profileId = "wechat-channels-managed-v1"; constructor(profilePath = resolve(homedir(), ".config/vietbridge-social/chrome/wechat-channels")) {} const endpoint = "http://127.0.0.1:19224"; const flags = ["--remote-debugging-port=19224", "--remote-debugging-address=127.0.0.1"];',
  'xiaohongshu-mcp-connector.ts':'constructor(endpoint = "http://127.0.0.1:18060/mcp") {}'
 };
 for(const [name,source] of Object.entries(sources))writeFileSync(join(legacyRoot,'src',name),source);
 const legacyDb=new DatabaseSync(join(legacyRoot,'data/publisher.sqlite'));
 legacyDb.exec('CREATE TABLE profile_health(profile_id TEXT,account_id TEXT,checked_at TEXT,status TEXT)');
 legacyDb.prepare('INSERT INTO profile_health VALUES(?,?,?,?)').run('wechat-channels-managed-v1','sph-fixture-channel','2026-10-11T03:41:34.485Z','READY');legacyDb.close();
 const dbPath=join(root,'target.sqlite'),store=new Store(dbPath,{seedDemo:false}),publisher=new UnifiedPublisher(store),ws=store.saveWorkspace({name:'Fixture VietBridge',library_kind:'enterprise',content_root:contentRoot});
 const lpRoot=join(contentRoot,'clients/lp');mkdirSync(lpRoot,{recursive:true});const lp=store.saveWorkspace({name:'Fixture LP Visa',library_kind:'client',content_root:lpRoot});
 const image=join(contentRoot,'cover.png'),video=join(contentRoot,'movie.mp4');
 writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
 writeFileSync(video,Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50]));
 const options={workspace:ws.id,legacyRoot,homeDir},xhs=extra=>publisher.saveAccount(ws.id,{platform:'xiaohongshu',display_name:'Fixture XHS',expected_identity:'Fixture XHS',external_id:'username:Fixture XHS',...extra});
 let seq=0;
 const content=(extra={})=>publisher.importContent(ws.id,{source_id:'fixture-'+(++seq),revision:'1',title:'Fixture article',body:'Complete fixture body.\nSecond paragraph.',media:[image],...extra});
 const job=(account,extra={})=>publisher.createPageJob(ws.id,{account_id:account.id,content_id:content(extra).id,payload:{tags:['Fixture']}});
 let closed=false;const cleanup=()=>{if(closed)return;closed=true;store.close();rmSync(root,{recursive:true,force:true});};t?.after(cleanup);
 return {root,legacyRoot,contentRoot,homeDir,channelDir,dbPath,store,publisher,ws,lp,options,image,video,xhs,content,job,cleanup};
}
