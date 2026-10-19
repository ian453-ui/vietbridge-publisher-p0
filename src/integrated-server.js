import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {createApp} from './server.js';
import {cloudRuntime} from './cloud-runtime.js';

const path=process.argv[2];
if(!path||!path.startsWith('/')||!existsSync(path))throw Error('请显式指定现有 V2 数据库绝对路径');
const runtime=cloudRuntime();
if(runtime?.mode!=='mac-tunnel')throw Error('整合发布入口必须配置已认证的 mac-tunnel 模式');
if(!process.env.PUBLISHER_INTEGRATION_CONFIG)throw Error('缺少整合配置路径');
const server=createApp(resolve(path));
server.listen(Number(process.env.PORT||17882),'127.0.0.1',()=>console.log('VietBridge integrated authenticated service ready'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
