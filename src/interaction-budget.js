import {randomUUID} from 'node:crypto';
import {facebookPostTarget,interactionError} from './interaction-target.js';

export function interactionTarget(url,externalId){return facebookPostTarget(url,{externalId}).budgetKey;}
/** Both discovery strategies reserve this ledger inside the Store transaction. */
export class InteractionBudget {
  constructor(store){this.store=store;this.db=store.db;this.db.exec(`CREATE TABLE IF NOT EXISTS interaction_budget(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,account_id TEXT NOT NULL,group_id TEXT,author_key TEXT,target TEXT NOT NULL,operation TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace,account_id,target,operation));CREATE INDEX IF NOT EXISTS interaction_budget_scope ON interaction_budget(workspace,account_id,state,created_at);`);}
  usage(workspace,accountId,since,{groupId,author}={}){const conditions=[],args=[workspace,accountId,since];if(groupId!==undefined){conditions.push('group_id=?');args.push(groupId);}if(author!==undefined){conditions.push('author_key=?');args.push(author);}const extra=conditions.length?' AND '+conditions.join(' AND '):'';const ledger=this.db.prepare("SELECT count(*) n FROM interaction_budget WHERE workspace=? AND account_id=? AND created_at>=? AND operation='REPLY' AND state IN ('RESERVED','CONSUMED')"+extra).get(...args).n;const legacy=this.db.prepare("SELECT count(*) n FROM quota_events q WHERE workspace=? AND account_id=? AND reserved_at>=? AND operation='REPLY' AND state IN ('RESERVED','CONSUMED')"+extra+" AND NOT EXISTS(SELECT 1 FROM interaction_budget b WHERE b.workspace=q.workspace AND b.account_id=q.account_id AND b.operation='REPLY' AND b.owner='theme:'||q.subject_id AND b.state IN ('RESERVED','CONSUMED'))").get(...args).n;return ledger+legacy;}
  status(workspace,accountId){const policy=this.store.engagementPolicy(workspace,accountId),since=new Date(Date.now()-86400000).toISOString(),used=this.usage(workspace,accountId,since);return {used,dailyLimit:policy?.daily_reply_limit||12,remaining:Math.max(0,(policy?.daily_reply_limit||12)-used)};}

  assertAvailable({workspace,accountId,groupId,target,operation='REPLY'}){
    if(!/^post:[1-9]\d*$/.test(String(target)))throw interactionError('INVALID_INTERACTION_TARGET','互动目标必须是真实帖子 ID');
    const legacy=this.db.prepare("SELECT target FROM interaction_budget WHERE workspace=? AND account_id=? AND (group_id=? OR group_id IS NULL) AND state IN ('RESERVED','CONSUMED')").all(workspace,accountId,groupId).some(row=>!/^post:[1-9]\d*$/.test(row.target));
    const oldQuota=this.db.prepare("SELECT 1 FROM quota_events q JOIN engagement_candidates c ON c.id=q.subject_id JOIN fb_comments m ON m.id=c.comment_id JOIN published_posts p ON p.id=m.post_id WHERE q.workspace=? AND q.account_id=? AND q.group_id=? AND q.state IN ('RESERVED','CONSUMED') AND p.job_id LIKE 'radar-group:%' LIMIT 1").get(workspace,accountId,groupId);
    if(legacy||oldQuota)throw interactionError('LEGACY_TARGET_RECONCILIATION_REQUIRED','历史群组级互动锁缺少可靠帖子归属，保留原锁并等待人工核对');
    if(operation==='REPLY')for(const row of this.db.prepare("SELECT q.group_id,p.post_url FROM quota_events q LEFT JOIN engagement_candidates c ON c.id=q.subject_id LEFT JOIN fb_comments m ON m.id=c.comment_id LEFT JOIN published_posts p ON p.id=m.post_id WHERE q.workspace=? AND q.account_id=? AND q.operation='REPLY' AND q.state IN ('RESERVED','CONSUMED') AND NOT EXISTS(SELECT 1 FROM interaction_budget b WHERE b.workspace=q.workspace AND b.account_id=q.account_id AND b.operation='REPLY' AND b.owner='theme:'||q.subject_id AND b.state IN ('RESERVED','CONSUMED'))").all(workspace,accountId)){
      if(!row.group_id)throw interactionError('LEGACY_TARGET_RECONCILIATION_REQUIRED','旧预留缺少群组归属，保留历史并等待核对');
      let key;try{key=facebookPostTarget(row.post_url).budgetKey;}catch{if(!row.group_id||row.group_id===groupId)throw interactionError('LEGACY_TARGET_RECONCILIATION_REQUIRED','旧互动预留无法可靠关联真实帖子，保留历史并等待核对');}
      if(key===target)throw interactionError('TARGET_ALREADY_RESERVED','原帖子已有历史回复或预留，保留原记录，禁止重复互动');
    }
    const old=this.db.prepare('SELECT * FROM interaction_budget WHERE workspace=? AND account_id=? AND target=? AND operation=?').get(workspace,accountId,target,operation);
    if(old&&old.state!=='RELEASED')throw interactionError('TARGET_ALREADY_RESERVED','同一账号已在其他互动入口处理或预留此真实帖子');
  }
  reserve({workspace,accountId,groupId,author,target,operation='REPLY',owner}){
    this.assertAvailable({workspace,accountId,groupId,target,operation});
    if(operation==='REPLY'){
      const status=this.status(workspace,accountId),policy=this.store.engagementPolicy(workspace,accountId);
      if(policy?.paused||policy?.cooldown_until>new Date().toISOString())throw Error('该账号互动已暂停或处于冷却期');
      if(!status.remaining)throw interactionError('ACCOUNT_REPLY_QUOTA_EXHAUSTED','账号共同回复额度已用完');
      const since=new Date(Date.now()-86400000).toISOString(),week=new Date(Date.now()-7*86400000).toISOString();
      const group=this.usage(workspace,accountId,since,{groupId}),byAuthor=this.usage(workspace,accountId,week,{author});
      if(group>=(policy?.group_daily_limit||3))throw interactionError('GROUP_REPLY_QUOTA_EXHAUSTED','群组共同回复额度已用完');
      if(byAuthor>=(policy?.author_weekly_limit||2))throw interactionError('AUTHOR_REPLY_QUOTA_EXHAUSTED','作者共同互动额度已用完');
    }
    this.db.prepare(`INSERT INTO interaction_budget VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace,account_id,target,operation) DO UPDATE SET owner=excluded.owner,state='RESERVED',created_at=excluded.created_at WHERE interaction_budget.state='RELEASED'`).run(randomUUID(),workspace,accountId,groupId||null,author||'',target,operation,owner,'RESERVED',new Date().toISOString());
  }
  finish(owner,state){if(!['CONSUMED','RELEASED'].includes(state))throw Error('互动额度状态无效');if(state==='RELEASED'&&this.db.prepare("SELECT target FROM interaction_budget WHERE owner=? AND state='RESERVED'").all(owner).some(row=>!/^post:[1-9]\d*$/.test(row.target)))throw interactionError('LEGACY_TARGET_RECONCILIATION_REQUIRED','历史错误目标锁不能自动释放');this.db.prepare("UPDATE interaction_budget SET state=? WHERE owner=? AND state='RESERVED'").run(state,owner);}
}
