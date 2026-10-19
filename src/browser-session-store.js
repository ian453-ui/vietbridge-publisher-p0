import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,existsSync,openSync,closeSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
export const SESSION_MAX_AGE_SECONDS=7*24*3600;
export const SESSION_TTL_MS=SESSION_MAX_AGE_SECONDS*1000;
const SESSION_SCHEMA='CREATE TABLE browser_sessions(session_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,credential_binding TEXT NOT NULL)';
const unavailable=()=>Error('SESSION_STORAGE_UNAVAILABLE');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Dedicated private storage. Never stores cookies, passwords or application tokens. */
export class BrowserSessionStore {
 constructor(directory){
  if(!isAbsolute(directory||''))throw unavailable();this.directory=directory;this.file=join(directory,'sessions.sqlite');
  try{if(!existsSync(directory))mkdirSync(directory,{recursive:true,mode:0o700});this.privateDirectory();if(!existsSync(this.file)){const fd=openSync(this.file,'wx',0o600);closeSync(fd);}this.withDb(db=>{if(db.prepare('SELECT count(*) n FROM sqlite_master').get().n===0)db.exec(SESSION_SCHEMA);this.validateSchema(db);},true);this.assertAvailable();}
  catch{throw unavailable();}
 }
 privateDirectory(){const s=lstatSync(this.directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700||process.getuid&&s.uid!==process.getuid())throw unavailable();}
 privateFiles(){this.privateDirectory();for(const file of [this.file,this.file+'-journal',this.file+'-wal',this.file+'-shm']){let s;try{s=lstatSync(file);}catch(error){if(file!==this.file&&error.code==='ENOENT')continue;throw unavailable();}if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600||process.getuid&&s.uid!==process.getuid())throw unavailable();}}
 withDb(fn,initialize=false){let db;try{this.privateFiles();db=new DatabaseSync(this.file);db.exec('PRAGMA busy_timeout=1500; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;');if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw unavailable();if(!initialize)this.validateSchema(db);return fn(db);}catch{throw unavailable();}finally{try{db?.close();}catch{throw unavailable();}}}
 validateSchema(db){
  const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all();
  const expected=[{type:'table',name:'browser_sessions',tbl_name:'browser_sessions',sql:SESSION_SCHEMA},{type:'index',name:'sqlite_autoindex_browser_sessions_1',tbl_name:'browser_sessions',sql:null}];
  if(JSON.stringify(objects)!==JSON.stringify(expected))throw unavailable();
  const columns=db.prepare('PRAGMA table_xinfo(browser_sessions)').all();
  const expectedColumns=[{cid:0,name:'session_hash',type:'TEXT',notnull:0,dflt_value:null,pk:1,hidden:0},{cid:1,name:'expires_at',type:'INTEGER',notnull:1,dflt_value:null,pk:0,hidden:0},{cid:2,name:'credential_binding',type:'TEXT',notnull:1,dflt_value:null,pk:0,hidden:0}];
  if(JSON.stringify(columns)!==JSON.stringify(expectedColumns))throw unavailable();
  if(db.prepare('SELECT * FROM browser_sessions').all().some(r=>!digest(r.session_hash)||!digest(r.credential_binding)||!Number.isSafeInteger(r.expires_at)||r.expires_at<0))throw unavailable();
 }
 revokeChecked(where='',values=[]){this.withDb(db=>{db.exec('BEGIN IMMEDIATE');try{this.validateSchema(db);db.prepare('DELETE FROM browser_sessions'+where).run(...values);if(db.prepare('SELECT count(*) n FROM browser_sessions'+where).get(...values).n!==0)throw unavailable();db.exec('COMMIT');}catch{db.exec('ROLLBACK');throw unavailable();}});}
 assertAvailable(){this.withDb(()=>{});}
 issue(sessionHash,binding,now){if(!digest(sessionHash)||!digest(binding)||!Number.isSafeInteger(now)||now<0)throw unavailable();return this.withDb(db=>{db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM browser_sessions WHERE expires_at<=? OR credential_binding<>?').run(now,binding);if(db.prepare('SELECT count(*) n FROM browser_sessions').get().n>=500)throw unavailable();db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(sessionHash,now+SESSION_TTL_MS,binding);db.exec('COMMIT');return now+SESSION_TTL_MS;}catch{db.exec('ROLLBACK');throw unavailable();}});}
 valid(sessionHash,binding,now){if(!digest(sessionHash)||!digest(binding)||!Number.isSafeInteger(now))return false;return this.withDb(db=>{const row=db.prepare('SELECT expires_at,credential_binding FROM browser_sessions WHERE session_hash=?').get(sessionHash);if(!row)return false;if(!Number.isSafeInteger(row.expires_at)||!digest(row.credential_binding))throw unavailable();return row.credential_binding===binding&&row.expires_at>now&&row.expires_at<=now+SESSION_TTL_MS;});}
 revoke(sessionHash){if(!digest(sessionHash))throw unavailable();this.revokeChecked(' WHERE session_hash=?',[sessionHash]);}
 revokeAll(){this.revokeChecked();}
}
