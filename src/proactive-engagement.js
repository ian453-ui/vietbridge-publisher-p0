const QUESTION=/[?？]|请问|怎么|如何|为什么|是否|能不能|有没有|ai biết|cho hỏi|làm sao|thế nào|tại sao|how|what|why|where|when|can i|could/i;
const AD=/\b(inbox|dm|zalo|whatsapp|telegram)\b|加微|私聊|优惠|促销|代办|招代理|招商|下单|价格私信|liên hệ|khuyến mãi|giá rẻ|mua ngay/i;
const SPAM=/^(顶|up|h[oó]ng|\p{Extended_Pictographic}|[\s.!?。！？])+$/iu;
const BAIT=/互赞|互关|求赞|点赞走一波|comment để|like chéo|follow back|drop your/i;
const UNSAFE=/仇恨|暴力|色情|诈骗|伪造|绕过|hack|lừa đảo|bạo lực|hate speech/i;
const FACT=/法规|法律|政策|税|签证|劳动法|企业注册|政府|手续|许可证|海关|关税|社保|最低工资|最新新闻|law|legal|tax|visa|policy|government|permit|registration|latest news|luật|thuế|visa|chính sách|chính phủ|giấy phép/i;
const NEGATIVE=/不需要|别回复|不要再回复|烦|举报|spam|don't reply|do not contact|leave me alone|stop replying|không cần|đừng trả lời|đừng liên hệ|báo cáo/i;

export function detectLanguage(text){
  const value=String(text||'');
  if(/[ăâđêôơưĂÂĐÊÔƠƯ]|\b(không|của|và|làm|cho|tôi|bạn|được)\b/i.test(value))return 'vi';
  if(/[\u3400-\u9fff]/.test(value))return 'zh';
  return 'en';
}

export function normalizePostText(text){return String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim();}

export function stablePostFingerprint(input){
  const normalized=[input.group_id||'',input.author||'',normalizePostText(input.body),input.published_at||input.timestamp||''].join('|');
  let h=2166136261;for(const ch of normalized){h^=ch.codePointAt(0);h=Math.imul(h,16777619)}return `fp-${(h>>>0).toString(16).padStart(8,'0')}`;
}

export function classifyEngagementPost(post,context={}){
  const body=normalizePostText(post.body),lower=body.toLowerCase(),topics=[...(context.project_topics||[]),...(context.group_topics||[])].map(x=>String(x).toLowerCase()).filter(Boolean);
  const language=detectLanguage(body);
  if(!body)return result('LOW_VALUE',0,false,false,'帖子没有可判断的正文',language);
  if(UNSAFE.test(body))return result('UNSAFE',0,false,false,'命中不安全内容规则',language);
  if(SPAM.test(body)||body.length<4)return result('LOW_VALUE',0,false,false,'水帖或信息量过低',language);
  if(BAIT.test(body))return result('ENGAGEMENT_BAIT',0,false,false,'互赞或互动诱导',language);
  const topicHits=topics.filter(x=>lower.includes(x));
  const question=QUESTION.test(body),links=(body.match(/https?:\/\//g)||[]).length,contacts=(body.match(/\b\d{8,}\b/g)||[]).length;
  if(AD.test(body)&&!question)return result('ADVERTISEMENT',Math.min(25,topicHits.length*8),false,false,'营销号召且没有真实求助',language);
  if(links&&!question&&body.replace(/https?:\/\/\S+/g,'').trim().length<20)return result('SPAM',0,false,false,'无上下文链接',language);
  const relevance=Math.min(100,topicHits.length*24+(question?24:0)+(body.length>=40?14:6)+(context.group_relevant?16:0));
  if(!topicHits.length&&relevance<35)return result('IRRELEVANT',relevance,false,false,'与 Project 和群组主题关联不足',language);
  const quality=Math.min(100,(body.length>=35?35:15)+(question?30:15)+(links<=1?15:5)+(contacts<=1?10:0));
  const shouldLike=relevance>=60&&quality>=45;
  const factSensitive=FACT.test(body);
  const canHelp=question&&relevance>=75&&quality>=45;
  const shouldReply=canHelp&&!factSensitive;
  const action=shouldLike&&canHelp?'LIKE_AND_REPLY':canHelp?'REPLY_ONLY':shouldLike?'LIKE_ONLY':'SKIP';
  return {classification:'VALID',language,relevance_score:relevance,content_quality:quality,question_intent:question?100:0,ability_to_help:canHelp?85:question?35:0,should_like:shouldLike,should_reply:shouldReply,action,fact_sensitive:factSensitive,needs_fact_search:factSensitive&&canHelp,reason:factSensitive&&canHelp?'涉及时效事实，完成可靠事实查询前禁止回复':'通过内容、相关性与帮助价值判断'};
}

export function candidateValue(row){return row.relevance_score*0.35+row.question_intent*0.2+row.ability_to_help*0.25+row.content_quality*0.15+recencyScore(row.published_at)*0.05;}
export function isNegativeReply(text){return NEGATIVE.test(String(text||''));}
export function requiresFactSearch(text){return FACT.test(String(text||''));}
export function chooseReplyLanguage(initialLanguage,latestReply){return latestReply?detectLanguage(latestReply):initialLanguage;}

function result(classification,relevance,like,reply,reason,language){return {classification,language,relevance_score:relevance,content_quality:0,question_intent:QUESTION.test(reason)?100:0,ability_to_help:0,should_like:like,should_reply:reply,action:'SKIP',fact_sensitive:false,needs_fact_search:false,reason};}
function recencyScore(value){const age=Date.now()-Date.parse(value||0);if(!Number.isFinite(age)||age<0)return 0;return Math.max(0,100-age/864000);}
