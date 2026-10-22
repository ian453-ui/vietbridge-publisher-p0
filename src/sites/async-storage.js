// Worker-compatible primitives; no identity, transport or runtime is invented here.
export const fail=code=>{throw Error(code);};
export const text=(x,max=1000)=>typeof x==='string'&&x.length>0&&x.length<=max&&x.trim()===x;
export const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export const exact=(x,keys,code='STORAGE_INPUT_INVALID')=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail(code);};
export const bytes=x=>x instanceof Uint8Array?x:x instanceof ArrayBuffer?new Uint8Array(x):Array.isArray(x)?new Uint8Array(x):fail('STORAGE_BYTES_INVALID');
export async function sha256(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export const digest=value=>sha256(JSON.stringify(value));
export class AsyncStorage {
 constructor(db){if(!db?.prepare||!db?.batch)fail('SITES_RUNTIME_BINDING_REQUIRED');this.db=db;}
 statement(query,args=[]){return this.db.prepare(query).bind(...args);}
 async rows(query,args=[]){const r=await this.statement(query,args).all();if(r.success===false||!Array.isArray(r.results))fail('STORAGE_UNAVAILABLE');return r.results;}
 async one(query,args=[]){return (await this.rows(query,args))[0]||null;}
 guard(predicate,args=[]){return this.statement('INSERT INTO sites_write_assertions(ok) SELECT CASE WHEN ('+predicate+') THEN 1 ELSE 0 END',args);}
 async batch(statements){const results=await this.db.batch([...statements,this.statement('DELETE FROM sites_write_assertions')]);if(!Array.isArray(results)||results.length!==statements.length+1||results.some(r=>r.success===false))fail('STORAGE_OUTCOME_UNCONFIRMED');}
 async scope(workspace,accountId){const a=await this.one('SELECT * FROM sites_account_details WHERE workspace=? AND account_id=?',[workspace??null,accountId??null]);if(!a)fail('STORAGE_SCOPE_DENIED');return a;}
 scopeGuard(workspace,accountId){return this.guard('EXISTS(SELECT 1 FROM sites_account_details WHERE workspace=? AND account_id=?)',[workspace,accountId]);}
 taskBinding(taskId,workspace,accountId){return [this.statement('INSERT INTO sites_task_bindings(task_id,workspace,account_id) VALUES(?,?,?) ON CONFLICT(task_id) DO NOTHING',[taskId,workspace,accountId]),this.guard('EXISTS(SELECT 1 FROM sites_task_bindings WHERE task_id=? AND workspace=? AND account_id=?)',[taskId,workspace,accountId])];}
}
