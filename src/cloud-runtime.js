import {timingSafeEqual,createHash} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {readAccessFile} from './publisher-access.js';
export function cloudRuntime(env=process.env){
 if(!['cloud','mac-tunnel'].includes(env.PUBLISHER_MODE))return null;
 const origin=new URL(env.PUBLIC_ORIGIN||'');
 if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash)throw Error('PUBLIC_ORIGIN 必须是 HTTPS 站点根地址');
 const password=env.ADMIN_PASSWORD||'';
 const accessFile=env.ADMIN_ACCESS_FILE||(env.DATA_DIR?join(env.DATA_DIR,'publisher-access.json'):null);
 if(accessFile&&!isAbsolute(accessFile))throw Error('ADMIN_ACCESS_FILE 必须为绝对路径');
 const saved=accessFile?readAccessFile(accessFile):null;
 if(!saved&&password.length<6)throw Error('ADMIN_PASSWORD 至少6个字符；或使用本地密码设置入口');
 if(!env.DATA_DIR?.startsWith('/'))throw Error('DATA_DIR 必须为绝对路径');
 if(env.PUBLISHER_MODE==='mac-tunnel'&&origin.hostname!=='publisher.vietbridge.one')throw Error('Mac Tunnel 唯一外网域名必须为 publisher.vietbridge.one');
 return {mode:env.PUBLISHER_MODE,executionConnected:env.PUBLISHER_MODE==='mac-tunnel',origin:origin.origin,host:origin.host,password,user:env.ADMIN_USER||'admin',dataDir:env.DATA_DIR,accessFile};
}
const digest=x=>createHash('sha256').update(x).digest();
export function authenticate(req,res,config){
 let decoded='';try{if(req.headers.authorization?.startsWith('Basic '))decoded=Buffer.from(req.headers.authorization.slice(6),'base64').toString('utf8')}catch{}
 if(timingSafeEqual(digest(decoded),digest(config.user+':'+config.password)))return true;
 res.writeHead(401,{'WWW-Authenticate':'Basic realm="VietBridge", charset="UTF-8"','Cache-Control':'no-store'});
 res.end('请登录 VietBridge 管理后台');return false;
}
