import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Db } from "./database.ts";
import { now } from "./util.ts";

export type FacebookAccount = { id:string; display_name:string; page_id:string; page_name:string; config_url:string; enabled:number; updated_at:string };

export class FacebookAccounts {
  private readonly db:Db;
  constructor(db:Db) { this.db=db;this.seedLegacy(); }
  list():{accounts:FacebookAccount[];selectedAccountId:string|null}{
    const accounts=this.db.prepare('SELECT * FROM facebook_accounts ORDER BY display_name').all() as FacebookAccount[];
    const selected=String((this.db.prepare("SELECT value FROM app_preferences WHERE key='facebook.selected_account.v1'").get() as {value?:string}|undefined)?.value||'');
    return {accounts,selectedAccountId:accounts.some(x=>x.id===selected&&x.enabled)?selected:(accounts.find(x=>x.enabled)?.id||null)};
  }
  get(id:string):FacebookAccount{return this.db.prepare('SELECT * FROM facebook_accounts WHERE id=? AND enabled=1').get(id) as FacebookAccount||fail('Facebook 账号不存在或已停用');}
  selected():FacebookAccount{const id=this.list().selectedAccountId;if(!id)throw new Error('请先配置 Facebook 账号');return this.get(id);}
  save(input:Record<string,unknown>):FacebookAccount{
    const id=String(input.id||randomUUID()),display=String(input.display_name||'').trim(),pageId=String(input.page_id||'').trim(),pageName=String(input.page_name||display).trim();
    const configUrl=normalizeLocalConfig(String(input.config_url||''));
    if(!display||!/^\d+$/.test(pageId)||!pageName)throw new Error('请填写账号名称、Page ID 和 Page 名称');
    const current=this.db.prepare('SELECT id FROM facebook_accounts WHERE id=?').get(id);
    if(input.id&&!current)throw new Error('要修改的 Facebook 账号不存在');
    this.db.prepare(`INSERT INTO facebook_accounts(id,display_name,page_id,page_name,config_url,enabled,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,page_id=excluded.page_id,page_name=excluded.page_name,config_url=excluded.config_url,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(id,display,pageId,pageName,configUrl,input.enabled===false?0:1,now());
    if(!this.list().selectedAccountId)this.select(id);
    return this.get(id);
  }
  importLocal(configUrl:string):Record<string,string>{
    const path=normalizeLocalConfig(configUrl),values=parseConfig(path);
    return {config_url:path,page_id:values.FB_PAGE_ID||'',page_name:values.FB_PAGE_NAME||'',display_name:values.FB_ACCOUNT_NAME||values.FB_PAGE_NAME||''};
  }
  select(id:string):FacebookAccount{const account=this.get(id);this.db.prepare(`INSERT INTO app_preferences(key,value,updated_at) VALUES('facebook.selected_account.v1',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(id,now());return account;}
  jobIdentity(account:FacebookAccount):string{return `facebook:${account.id}:${account.page_id}`;}
  resolveJobIdentity(value:string):FacebookAccount{
    const match=/^facebook:([^:]+):(\d+)$/.exec(value);
    if(!match){
      const candidates=this.list().accounts.filter(account=>account.enabled&&(account.display_name===value||account.page_name===value));
      if(candidates.length!==1)throw new Error(candidates.length?'旧 Facebook 任务的账号名称存在重复，无法安全确定目标 Page':'旧 Facebook 任务找不到原账号；请恢复账号映射后再核对');
      return candidates[0];
    }
    const account=this.get(match[1]);if(account.page_id!==match[2])throw new Error('Facebook 任务绑定的 Page 已被修改；请新建任务并重新确认');return account;
  }
  private seedLegacy():void{
    const count=Number((this.db.prepare('SELECT COUNT(*) n FROM facebook_accounts').get() as {n:number}).n);if(count)return;
    const path=process.env.VIETBRIDGE_SOCIAL_CREDENTIALS_FILE||`${process.env.HOME}/.config/vietbridge-social/credentials.env`;
    if(!existsSync(path))return;const values=parseConfig(path),pageId=values.FB_PAGE_ID;if(!/^\d+$/.test(pageId||''))return;
    this.db.prepare('INSERT INTO facebook_accounts(id,display_name,page_id,page_name,config_url,enabled,updated_at) VALUES(?,?,?,?,?,1,?)')
      .run('legacy-vietbridge',values.FB_ACCOUNT_NAME||values.FB_PAGE_NAME||'VietBridge Group',pageId,values.FB_PAGE_NAME||'VietBridge Group',normalizeLocalConfig(path),now());this.select('legacy-vietbridge');
  }
}

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
