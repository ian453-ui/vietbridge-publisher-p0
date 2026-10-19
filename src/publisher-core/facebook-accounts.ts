// Credential helpers ported from V1; account storage belongs to the unified Store.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type FacebookAccount = { id:string; display_name:string; page_id:string; page_name:string; config_url:string; enabled:number; updated_at:string };

export function normalizeLocalConfig(value:string):string{
  if(!value.trim())throw new Error('请填写本地账号配置文件地址');
  if(/^[a-z][a-z0-9+.-]*:/i.test(value)&&!value.startsWith('file://'))throw new Error('账号配置只允许本机文件地址');
  const path=value.startsWith('file://')?fileURLToPath(value):value;
  if(!existsSync(path)||!statSync(path).isFile())throw new Error('本地账号配置文件不存在');
  if((statSync(path).mode&0o077)!==0)throw new Error('本地账号配置文件权限过宽，请设为仅当前用户可读写（600）');
  return realpathSync(path);
}
export function parseConfig(path:string):Record<string,string>{
  const raw=readFileSync(path,'utf8');
  if(path.endsWith('.json')){const data=JSON.parse(raw);return Object.fromEntries(Object.entries(data).filter(([,v])=>typeof v==='string')) as Record<string,string>;}
  const result:Record<string,string>={};for(const line of raw.split(/\r?\n/)){const m=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(m)result[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}return result;
}
function fail(message:string):never{throw new Error(message)}

