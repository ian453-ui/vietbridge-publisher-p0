import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';import {restrictV1} from './v1-maintenance-policy.mjs';
import {registeredWorkspaceContext,readWorkspaceMetadata} from './v1-registered-workspace.mjs';
import {readFileSync,lstatSync,existsSync,unlinkSync,appendFileSync} from 'node:fs';
import {createClientSessionFactory,validateSessionScope} from './v1-client-bsk-session.mjs';import {createHash} from 'node:crypto';
const sha='f6178fbcdec390e5eecccdfbdfa7616209793210',release=process.env.PUBLISHER_RELEASE_DIR;
const social='/LOCAL_PATH_CONFIGURE_FOR_YOUR_HOST';
const dbPath=join(social,'Publisher-P0/data/publisher.sqlite');
if(!release?.endsWith('/'+sha)||process.env.PUBLISHER_BUILD_HEAD!==sha||process.env.GD_CREDENTIALS_PATH)throw Error('V1_EXACT_READ_ONLY_MAINTENANCE_REQUIRED');
const db=new DatabaseSync(dbPath,{readOnly:true});
try{if(db.prepare('SELECT COUNT(*) AS n FROM profile_locks').get().n)throw Error('V1_ACTIVE_PROFILE_OWNER');}finally{db.close();}
const {createPublisherServer,clientWorkspace}=await import(pathToFileURL(join(release,'src/web-server.client-context-20261014.ts')));
const workspaceResolver=async workspace=>{
 if(!['ws-vietbridge','REPLACE_WITH_CLIENT_WORKSPACE_ID'].includes(workspace))return clientWorkspace(workspace,'http://127.0.0.1:17885');
 const v1=new DatabaseSync(dbPath,{readOnly:true});let operator;
 try{if(workspace!=='ws-vietbridge')operator=new DatabaseSync(join(process.env.HOME,'Library/Application Support/VietBridgePublisherUnified/data/publisher-unified.sqlite'),{readOnly:true});return readWorkspaceMetadata(operator,v1,workspace,join(social,'Content-Library/clients'));}finally{operator?.close();v1.close();}
};
const hotfixHash=createHash('sha256').update(readFileSync(join(release,'src/web-server.client-context-20261014.ts'))).update(readFileSync(new URL('./v1-registered-workspace.mjs',import.meta.url))).update(readFileSync(new URL('./v1-maintenance-policy.mjs',import.meta.url))).update(readFileSync(join(release,'src/platform-worker.client-bsk-20261014.ts'))).update(readFileSync(new URL('./v1-client-bsk-session.mjs',import.meta.url))).update(readFileSync(new URL('./v1-bsk-client.mjs',import.meta.url))).update(readFileSync(new URL('./v1-bsk-publication.mjs',import.meta.url))).update(readFileSync(new URL('./v1-bsk-business-suite.mjs',import.meta.url))).digest('hex');
const sessionFile='/tmp/v1-client-011-session-runtime-20261014.json';let sessionScope=null;
if(existsSync(sessionFile)){const s=lstatSync(sessionFile);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw Error('BSK_PRIVATE_EPHEMERAL_SCOPE_REQUIRED');sessionScope=validateSessionScope(JSON.parse(readFileSync(sessionFile,'utf8')));unlinkSync(sessionFile);}
const sessionDb=new DatabaseSync(dbPath,{readOnly:true});
const facebookBrowserFactory=createClientSessionFactory({db:sessionDb,scope:sessionScope,onConnection:e=>appendFileSync('/LOCAL_PATH_CONFIGURE_FOR_YOUR_HOST',JSON.stringify(e)+'\n',{mode:0o600})});
const server=createPublisherServer({dbPath,workerEnabled:true,workspaceResolver,facebookBrowserFactory,workspaceServiceUrl:'http://127.0.0.1:17885',contentRoots:[join(social,'Content-Library'),'/LOCAL_PATH_CONFIGURE_FOR_YOUR_HOST'],ledgerPath:join(social,'Shared-Publication-State/shared-publication-ledger.yaml'),stagingRoot:join(social,'Publisher-P0/data/content-snapshots'),mirrorPath:join(social,'Shared-Publication-State/publisher-events.jsonl')});
restrictV1(server,sha,{hotfixHash,bootstrapDefault:async({workspace,activate})=>{
 const context=await workspaceResolver(workspace);
 const metadata=new DatabaseSync(dbPath,{readOnly:!activate});
 try{return registeredWorkspaceContext(metadata,workspace,context,{activate});}finally{metadata.close();}
}});
server.on('error',()=>server.close());
server.listen(17880,'::1',()=>console.log('V1 maintenance read-only '+sha+' http://[::1]:17880/'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
