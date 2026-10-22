import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../src/server.js';
const directory=resolve(process.argv[2]||'');
const demo=JSON.parse(readFileSync(join(directory,'demo.json'),'utf8'));
if(demo.synthetic_only!==true||demo.dbPath!==join(directory,'publisher-unified.sqlite'))throw Error('SYNTHETIC_DEMO_REQUIRED');
const server=createApp(demo.dbPath,{unified:true,executionEnabled:false,scanScheduler:false});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,synthetic_only:true,executionEnabled:false})));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
