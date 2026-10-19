import {createHash} from 'node:crypto';
import {facebookPostTarget,interactionError} from './interaction-target.js';
import {detectLanguage,requiresFactSearch} from './proactive-engagement.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function classifyThemeComment(body,policy){
  const text=String(body||''),excluded=policy.excluded.find(x=>text.toLowerCase().includes(x.toLowerCase())),topic=policy.topics.find(x=>text.toLowerCase().includes(x.toLowerCase()));
  if(excluded)return {topic:null,risk:'BLOCKED',state:'SKIP',reason:`命中排除词：${excluded}`};
  if(!topic)return {topic:null,risk:'LOW',state:'SKIP',reason:'没有命中配置主题'};
  if(needsThemeEvidence(text))return {topic,risk:'HIGH',state:'HUMAN_REVIEW',reason:'涉及事实、法律、政策、价格或个人信息，需要独立证据；此入口不发送'};
  if(!/[?？]|请问|怎么|如何|为什么|是否|能不能|有没有|cho hỏi|làm sao|thế nào|tại sao|\b(how|what|why|where|when|could|can)\b/i.test(text))return {topic,risk:'LOW',state:'SKIP',reason:'不是明确的问题或求助'};
  return {topic,risk:'LOW',state:'REPLY_CANDIDATE',reason:'主题相关的低风险问题；回复稿待人工编写并审核'};
}
export function needsThemeEvidence(text){return requiresFactSearch(text)||/律师|劳动争议|违法|处罚|赔偿|解雇|合同|政治|价格|报价|投诉|隐私|身份证|电话|\b(price|cost|contract|compensation|salary|personal data|phone number)\b|giá|hợp đồng|lương|khiếu nại|điện thoại/i.test(String(text||''));}
export function themeTarget(store,workspace,candidate){
  const account=store.account(workspace,candidate.account_id),comment=store.comment(workspace,candidate.comment_id),post=store.db.prepare('SELECT * FROM published_posts WHERE id=? AND workspace=? AND account_id=?').get(comment.post_id,workspace,account.id);
  if(comment.account_id!==account.id||!post)throw interactionError('INVALID_INTERACTION_SCOPE','评论与帖子不属于当前客户/账号');
  const radarSource=/^radar-(group|post):/.test(post.job_id);
  if(radarSource){
    const radar=store.db.prepare('SELECT * FROM radar_posts WHERE workspace=? AND account_id=? AND group_id=? AND external_id=?').get(workspace,account.id,post.group_id,comment.external_id),group=store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=? AND account_id=? AND enabled=1').get(post.group_id,workspace,account.id);
    if(!radar||!group)throw interactionError('INVALID_INTERACTION_TARGET','缺少实际帖子来源，或目标群组已停用');
    const target=facebookPostTarget(radar.permalink,{externalId:radar.external_id,groupUrl:group.url});
    if(post.job_id.startsWith('radar-post:')&&facebookPostTarget(post.post_url,{externalId:radar.external_id,groupUrl:group.url}).url!==target.url)throw interactionError('INVALID_INTERACTION_TARGET','冻结父帖子与雷达来源不一致');
    return {...target,kind:'RADAR',groupId:group.id,sourceGroupId:target.groupId,account,comment,post,sourceBody:radar.body,sourceAuthor:radar.author};
  }
  const group=post.group_id==='PAGE'?null:store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=? AND account_id=? AND enabled=1').get(post.group_id,workspace,account.id);
  if(post.group_id!=='PAGE'&&!group)throw interactionError('INVALID_INTERACTION_TARGET','来源群组不属于当前账号或已停用');
  const externalId=post.job_id.startsWith('page:')?post.job_id.split(':').at(-1):undefined;
  const target=facebookPostTarget(post.post_url,{externalId,groupUrl:group?.url,commentId:comment.external_id,parentCommentId:comment.parent_id});
  if(post.group_id==='PAGE'&&account.target_page_id&&target.ownerId!==account.target_page_id){
    // Unified Publisher may read back a Page publication under its operator actor.
    // Require the exact durable Page receipt before treating that actor URL as bound.
    const verified=store.db.prepare("SELECT snapshot_json,evidence_json FROM publisher_jobs WHERE workspace=? AND account_id=? AND state='PUBLISHED' ORDER BY updated_at DESC LIMIT 50").all(workspace,account.id).some(job=>{try{const frozen=JSON.parse(job.snapshot_json),evidence=JSON.parse(job.evidence_json);return evidence?.verified===true&&frozen.platform==='facebook'&&frozen.identityType==='PAGE'&&frozen.operatorActorId===account.external_id&&frozen.targetPageId===account.target_page_id&&evidence.id===target.postId&&evidence.url?.replace(/\/$/,'')===target.permalink.replace(/\/$/,'')&&post.post_url.replace(/\/$/,'')===target.permalink.replace(/\/$/,'');}catch{return false;}});
    if(!verified)throw interactionError('INVALID_INTERACTION_TARGET','评论帖子不属于已绑定的 Business Page');
  }
  return {...target,kind:'INBOX',groupId:post.group_id,sourceGroupId:target.groupId,account,comment,post,sourceBody:comment.body,sourceAuthor:comment.author};
}
function scopeFor(store,workspace,candidate){
  const target=themeTarget(store,workspace,candidate),a=target.account,actorId=a.operator_actor_id||a.external_id;
  if(!/^[1-9]\d*$/.test(actorId||'')||a.external_id!==actorId)throw interactionError('INVALID_INTERACTION_SCOPE','实际操作 actor ID 尚未可靠绑定');
  const scope={workspace,accountId:a.id,actorId,profileId:a.profile_id,expectedIdentity:a.expected_identity,businessPageId:a.target_page_id||null,transport:'BROWSER',kind:target.kind,postId:target.postId,commentId:target.commentId,parentCommentId:target.parentCommentId,groupId:target.groupId,url:target.url,sourceBody:target.sourceBody,sourceAuthor:target.sourceAuthor,commentBody:target.comment.body};
  return {target,scope,scopeHash:digest(scope)};
}
export function candidateReviewView(store,workspace,candidate){
  let info,blocker='';try{info=scopeFor(store,workspace,candidate);}catch(error){blocker=error.message;}
  const review=store.db.prepare('SELECT * FROM engagement_draft_reviews WHERE candidate_id=? AND workspace=? AND account_id=?').get(candidate.id,workspace,candidate.account_id),reviewed=Boolean(info&&review?.reviewed_at&&review.scope_hash===info.scopeHash&&review.draft_hash===digest(candidate.draft));
  const classified=classifyThemeComment(info?.target.sourceBody||store.comment(workspace,candidate.comment_id).body,store.engagementPolicy(workspace,candidate.account_id)||{topics:[],excluded:[]});
  if(!blocker&&candidate.state!=='REPLY_CANDIDATE')blocker=candidate.reason;
  if(!blocker&&classified.state!=='REPLY_CANDIDATE')blocker=classified.reason;
  if(!blocker&&info?.target.parentCommentId)blocker='嵌套评论缺少精确回复关联读回，只保存稿件，不发送';
  if(!blocker&&needsThemeEvidence(candidate.draft))blocker='回复稿涉及需要事实证据的内容，此入口不发送';
  if(!blocker&&info)try{store.interactionBudget?.assertAvailable({workspace,accountId:candidate.account_id,groupId:info.target.groupId,target:info.target.budgetKey});}catch(error){blocker=error.message;}
  if(!blocker&&!reviewed)blocker='回复稿待编写并审核；未审核不会发送';
  return {...candidate,source_url:info?.target.url||null,post_external_id:info?.target.postId||null,comment_external_id:info?.target.commentId||null,actor_id:info?.scope.actorId||null,scope_hash:info?.scopeHash||null,source_language:detectLanguage(info?.target.sourceBody||''),draft_review:reviewed?'REVIEWED':'PENDING',reviewed_at:reviewed?review.reviewed_at:null,blocker,can_send:reviewed&&!blocker};
}
export function saveCandidateDraft(store,workspace,candidateId,input){
  const candidate=store.engagementCandidate(workspace,candidateId);
  if(input.account_id!==candidate.account_id)throw Error('回复稿账号不属于当前候选');
  if(!['REPLY_CANDIDATE','HUMAN_REVIEW','SKIP'].includes(candidate.state))throw Error('当前候选已锁定，不能修改回复稿');
  const info=scopeFor(store,workspace,candidate);
  if(input.scope_hash!==info.scopeHash)throw Error('来源或身份已变化，请刷新并重新核对');
  const body=String(input.body||'').trim();if(body.length>4000)throw Error('回复稿过长');
  const classification=classifyThemeComment(info.target.sourceBody,store.engagementPolicy(workspace,candidate.account_id)||{topics:[],excluded:[]});
  if(input.reviewed===true){
    if(!body||candidate.state!=='REPLY_CANDIDATE'||candidate.risk!=='LOW'||classification.state!=='REPLY_CANDIDATE'||needsThemeEvidence(body))throw Error('只有低风险且不需要事实证据的非空回复稿可以审核');
    if(detectLanguage(body)!==detectLanguage(info.target.sourceBody))throw Error('回复稿需要使用原帖语言');
  }
  return store.tx(()=>{const now=new Date().toISOString();store.db.prepare('UPDATE engagement_candidates SET draft=?,updated_at=? WHERE id=? AND workspace=? AND account_id=?').run(body,now,candidate.id,workspace,candidate.account_id);store.db.prepare('INSERT INTO engagement_draft_reviews VALUES(?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET scope_hash=excluded.scope_hash,draft_hash=excluded.draft_hash,reviewed_at=excluded.reviewed_at').run(candidate.id,workspace,candidate.account_id,info.scopeHash,digest(body),input.reviewed===true?now:null);return candidateReviewView(store,workspace,store.engagementCandidate(workspace,candidate.id));});
}
export function assertCandidateReviewed(store,workspace,candidateId){
  const candidate=store.engagementCandidate(workspace,candidateId),info=scopeFor(store,workspace,candidate),review=store.db.prepare('SELECT * FROM engagement_draft_reviews WHERE candidate_id=? AND workspace=? AND account_id=?').get(candidate.id,workspace,candidate.account_id);
  if(!review?.reviewed_at||review.scope_hash!==info.scopeHash||review.draft_hash!==digest(candidate.draft)||!candidate.draft)throw interactionError('DRAFT_REVIEW_REQUIRED','来源、身份或回复稿尚未审核或已变化，请重新核对');
  const classification=classifyThemeComment(info.target.sourceBody,store.engagementPolicy(workspace,candidate.account_id)||{topics:[],excluded:[]});
  if(classification.state!=='REPLY_CANDIDATE'||needsThemeEvidence(candidate.draft))throw interactionError('FACT_EVIDENCE_REQUIRED','主题或事实风险已变化，不能发送');
  if(info.target.parentCommentId)throw interactionError('COMMENT_PARENT_EVIDENCE_REQUIRED','嵌套评论缺少精确回复关联读回，不发送');
  return info.target;
}
