import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {Db} from './database.ts';
import {transaction} from './database.ts';
import type {ContentLibrary} from './content-library.ts';
import {canonicalJson,newId,now,sha256} from './util.ts';

type VisibleItem={title:string;url:string;channel:string};
export type ReconcileResult={scanned:number;matched:number;ledgerUpdated:number;jobsUpdated:number;ambiguous:number;matchedArticles:{article_id:string;title:string;url:string}[]};

export class PublicationLedgerReconciler {
  readonly path:string;
  readonly db:Db;readonly library:ContentLibrary;
  constructor(db:Db,library:ContentLibrary,sharedLedgerPath:string){this.db=db;this.library=library;this.path=join(dirname(sharedLedgerPath),'verified-publications.jsonl');}
  syncVerifiedJob(jobId:string,existing=this.latest()):boolean{
    const job=this.db.prepare(`SELECT article_id,platform,account_id,state,platform_id,platform_url,last_verified_at FROM jobs WHERE job_id=?`).get(jobId) as Record<string,unknown>|undefined;
    if(!job||!job.last_verified_at||!['PUBLISHED','DRAFT_API_WRITTEN_NOT_PUBLISHED','PLATFORM_DELETED'].includes(String(job.state)))return false;
    const transition=this.db.prepare(`SELECT evidence_json FROM state_transitions WHERE job_id=? AND to_state=? ORDER BY created_at DESC LIMIT 1`).get(jobId,String(job.state)) as {evidence_json:string}|undefined;
    let evidence:Record<string,unknown>={};try{evidence=JSON.parse(transition?.evidence_json||'{}');}catch{return false;}
    if(evidence.independentReadback!==true&&evidence.completeDraftListReadback!==true)return false;
    const platform=String(job.platform),status=platform==='wechat_official_account'&&job.state==='PLATFORM_DELETED'?'DRAFT_DELETED':String(job.state),articleId=String(job.article_id),previous=existing.get(articleId+'|'+platform);
    if(previous?.verified_at&&String(previous.verified_at)>String(job.last_verified_at))return false;
    // An independently verified draft is not a reversal of a published article.
    // Deleting a WeChat draft likewise says nothing about an existing public URL.
    if(platform==='wechat_official_account'&&previous?.status==='PUBLISHED'&&status!=='PUBLISHED')return false;
    if(previous?.status===status&&String(previous.platform_id||'')===String(job.platform_id||'')&&String(previous.platform_url||'')===String(job.platform_url||''))return false;
    const event={article_id:articleId,platform,account_id:String(job.account_id||''),status,platform_id:String(job.platform_id||''),platform_url:String(job.platform_url||''),verified_at:String(job.last_verified_at),source:'publisher_independent_readback',job_id:jobId};
    mkdirSync(dirname(this.path),{recursive:true});appendFileSync(this.path,canonicalJson(event)+'\n',{encoding:'utf8',mode:0o600});existing.set(articleId+'|'+platform,event);return true;
  }
  syncVerifiedJobs():number{
    let updated=0;const existing=this.latest();
    const rows=this.db.prepare(`SELECT job_id FROM jobs WHERE last_verified_at IS NOT NULL AND state IN ('PUBLISHED','DRAFT_API_WRITTEN_NOT_PUBLISHED','PLATFORM_DELETED') ORDER BY last_verified_at,job_id`).all() as {job_id:string}[];
    for(const row of rows)if(this.syncVerifiedJob(row.job_id,existing))updated++;
    return updated;
  }
  reconcileWechat(items:VisibleItem[],checkedAt=now()):ReconcileResult{
    const published=items.filter(item=>item.channel==='published'&&item.title&&item.url),packages=this.library.index(),byArticle=new Map<string,{title:string}>();
    for(const item of packages)if(!byArticle.has(item.articleId))byArticle.set(item.articleId,{title:item.title});
    const existing=this.latest(),matchedArticles:ReconcileResult['matchedArticles']=[];let ledgerUpdated=0,jobsUpdated=0,ambiguous=0;
    for(const [articleId,content] of byArticle){
      const key=normalizeTitle(content.title),matches=published.filter(item=>titleMatches(key,normalizeTitle(item.title)));
      if(matches.length>1){ambiguous++;continue;}if(matches.length!==1)continue;
      const match=matches[0],event={article_id:articleId,platform:'wechat_official_account',status:'PUBLISHED',title:match.title,platform_url:match.url,verified_at:checkedAt,source:'wechat_admin_full_pagination_readback'};
      matchedArticles.push({article_id:articleId,title:match.title,url:match.url});
      const previous=existing.get(articleId+'|wechat_official_account');
      if(!previous||previous.status!==event.status||previous.platform_url!==event.platform_url){mkdirSync(dirname(this.path),{recursive:true});appendFileSync(this.path,canonicalJson(event)+'\n',{encoding:'utf8',mode:0o600});existing.set(articleId+'|wechat_official_account',event);ledgerUpdated++;}
      const job=this.db.prepare(`SELECT * FROM jobs WHERE article_id=? AND platform='wechat_official_account' ORDER BY created_at DESC LIMIT 1`).get(articleId) as Record<string,unknown>|undefined;
      if(job&&(job.state!=='PUBLISHED'||job.platform_url!==match.url)){
        transaction(this.db,()=>{const time=now(),eventId=newId(),from=String(job.state);this.db.prepare('UPDATE jobs SET state=?,platform_url=?,published_at=?,last_verified_at=?,updated_at=? WHERE job_id=?').run('PUBLISHED',match.url,time,time,time,String(job.job_id));this.db.prepare('INSERT INTO state_transitions(job_id,from_state,to_state,event_id,evidence_json,created_at) VALUES(?,?,?,?,?,?)').run(String(job.job_id),from,'PUBLISHED',eventId,canonicalJson({independentReadback:true,source:'wechat_admin_full_pagination_readback',url:match.url,title:match.title,noSubmission:true}),time);const payload=canonicalJson({from,to:'PUBLISHED',evidence:{source:'wechat_admin_full_pagination_readback',url:match.url},time});this.db.prepare('INSERT INTO outbox_events(event_id,job_id,event_type,payload_json,payload_hash,created_at) VALUES(?,?,?,?,?,?)').run(eventId,String(job.job_id),'STATE_TRANSITION',payload,sha256(payload),time);});jobsUpdated++;
      }
    }
    return {scanned:published.length,matched:matchedArticles.length,ledgerUpdated,jobsUpdated,ambiguous,matchedArticles};
  }
  private latest():Map<string,any>{const result=new Map<string,any>();if(!existsSync(this.path))return result;for(const line of readFileSync(this.path,'utf8').split(/\r?\n/)){if(!line.trim())continue;try{const row=JSON.parse(line),key=String(row.article_id||'')+'|'+String(row.platform||'');if(row.article_id&&row.platform)result.set(key,row);}catch{/* append-only corruption does not erase earlier evidence */}}return result;}
}

function normalizeTitle(value:string):string{return String(value||'').replace(/^重新发布\s*·\s*/,'').replace(/^\d{8}-\d{4}\s*/,'').replace(/\s+/g,'').replace(/[“”"'，。！？：；、·—（）()《》]/g,'').toLowerCase();}
function titleMatches(a:string,b:string):boolean{return a.length>=10&&b.length>=10&&(a===b||a.includes(b)||b.includes(a));}
