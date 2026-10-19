import {randomUUID} from 'node:crypto';

const fields=['job_id','content_id','workspace','account_id','operator_actor_id','target_page_id','platform','transport','snapshot_hash','media_count'];
const denied=reason=>({canExecute:false,mode:'SINGLE_USE',reason});

export function executionScope(job) {
  const s=job.snapshot;
  if(s.workspace!==job.workspace||s.accountId!==job.account_id||s.contentId!==job.content_id||!Array.isArray(s.media))throw Error('任务范围与冻结快照不一致');
  return {job_id:job.id,content_id:job.content_id,workspace:job.workspace,account_id:job.account_id,
    operator_actor_id:s.operatorActorId,target_page_id:s.targetPageId,platform:s.platform,transport:s.transport,
    snapshot_hash:job.snapshot_hash,media_count:s.media.length};
}

/** Issued only by a local administration command; never by an HTTP grant endpoint. */
export class SingleExecutionPermits {
  constructor(publisher,{now=()=>Date.now()}={}) {
    this.publisher=publisher;this.db=publisher.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS publisher_execution_permits(
      id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES publisher_jobs(id),
      scope_json TEXT NOT NULL,authorization_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('AVAILABLE','CONSUMED','REVOKED')),
      issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER,revoked_at INTEGER,attempt_id TEXT,
      CHECK(expires_at>issued_at));
      CREATE TABLE IF NOT EXISTS publisher_execution_permit_events(
        seq INTEGER PRIMARY KEY,permit_id TEXT NOT NULL REFERENCES publisher_execution_permits(id),
        event TEXT NOT NULL CHECK(event IN ('ISSUED','CONSUMED','REVOKED')),
        detail_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  record(jobId){return this.db.prepare('SELECT * FROM publisher_execution_permits WHERE job_id=?').get(jobId);}
  assertFresh(job) {
    if(job.state!=='READY'||job.attempt_id)throw Error('单次许可仅适用于尚未尝试的已确认任务');
    this.publisher.assertCurrent(job);
    const s=job.snapshot;
    if(s.platform!=='facebook'||s.transport!=='BROWSER'||s.identityType!=='PAGE'||s.operation!=='FACEBOOK_PAGE_PUBLISH'||s.externalId!==s.operatorActorId||s.media.length!==0)throw Error('单次许可仅适用于冻结的 Facebook 浏览器纯文本 Page 任务');
    for(const table of ['publisher_prepare_intents','publisher_submit_intents','publisher_submit_receipts','publisher_job_assets'])
      if(this.db.prepare(`SELECT 1 FROM ${table} WHERE job_id=? LIMIT 1`).get(job.id))throw Error('任务已有执行痕迹，不能使用单次许可');
  }
  issue(workspace,id,scope,{expiresAt,authorization}={}) {
    return this.publisher.store.tx(()=>{
      const job=this.publisher.job(workspace,id);this.assertFresh(job);
      const expected=executionScope(job);
      if(!scope||Object.keys(scope).length!==fields.length||fields.some(key=>scope[key]!==expected[key]))throw Error('许可必须完整匹配任务、内容、客户、账号、actor、Page、平台、方式、hash 与媒体数');
      const now=this.now();
      if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+24*3600000)throw Error('单次许可须有未来24小时内的明确期限');
      if(!authorization||['task_id','approval_thread_id','approval_message_id'].some(key=>typeof authorization[key]!=='string'||!authorization[key].trim()||authorization[key].length>200))throw Error('缺少可审计的用户授权来源');
      if(this.record(id))throw Error('此任务已有单次许可记录，不得续期、恢复或重新签发');
      const permitId=randomUUID();
      this.db.prepare("INSERT INTO publisher_execution_permits(id,job_id,scope_json,authorization_json,status,issued_at,expires_at) VALUES(?,?,?,?,'AVAILABLE',?,?)")
        .run(permitId,id,JSON.stringify(expected),JSON.stringify(authorization),now,expiresAt);
      this.audit(permitId,'ISSUED',{scope:expected,authorization},now);
      return this.capability(job);
    });
  }
  audit(id,event,detail,now){this.db.prepare('INSERT INTO publisher_execution_permit_events(permit_id,event,detail_json,created_at) VALUES(?,?,?,?)').run(id,event,JSON.stringify(detail),now);}
  capability(job) {
    const row=this.record(job.id);if(!row)return denied('未签发此任务的单次执行许可');
    const metadata={permitId:row.id,permitStatus:row.status,expiresAt:new Date(row.expires_at).toISOString()};
    if(row.status!=='AVAILABLE')return {...denied(row.status==='CONSUMED'?'此任务的单次执行许可已消费，不能重试':'此任务的单次执行许可已撤销'),...metadata};
    if(row.expires_at<=this.now())return {...denied('此任务的单次执行许可已过期'),...metadata,permitStatus:'EXPIRED'};
    try {
      const scope=JSON.parse(row.scope_json),expected=executionScope(job);
      if(Object.keys(scope).length!==fields.length||fields.some(key=>scope[key]!==expected[key]))throw Error('任务与单次许可的完整范围不一致');
      this.assertFresh(job);
      return {canExecute:true,mode:'SINGLE_USE',...metadata};
    }catch(error){return {...denied(error.message),...metadata};}
  }
  consume(job,attemptId) {
    if(!this.db.isTransaction)throw Error('单次许可必须在任务 claim 的同一事务内消费');
    const capability=this.capability(job);if(!capability.canExecute)throw Error(capability.reason);
    const now=this.now();
    const update=this.db.prepare("UPDATE publisher_execution_permits SET status='CONSUMED',consumed_at=?,attempt_id=? WHERE id=? AND status='AVAILABLE' AND expires_at>?").run(now,attemptId,capability.permitId,now);
    if(update.changes!==1)throw Error('单次许可已失效或被其他执行者消费');
    this.audit(capability.permitId,'CONSUMED',{job_id:job.id,snapshot_hash:job.snapshot_hash,attempt_id:attemptId},now);
  }
  revoke(workspace,id,reason) {
    return this.publisher.store.tx(()=>{
      this.publisher.job(workspace,id);const row=this.record(id);
      if(!row||row.status!=='AVAILABLE')throw Error('只有尚未消费的单次许可可撤销');
      if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw Error('请提供撤销原因');
      const now=this.now();this.db.prepare("UPDATE publisher_execution_permits SET status='REVOKED',revoked_at=? WHERE id=? AND status='AVAILABLE'").run(now,row.id);
      this.audit(row.id,'REVOKED',{reason},now);return this.capability(this.publisher.job(workspace,id));
    });
  }
}
