import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {parseStrictJson} from './strict-json.js';
import {createGptContentRequest,inspectGptContentResult,bindGptResultToInbox} from './gpt-content-contract.js';
import {readGptDriveInbox} from './gpt-drive-inbox.js';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function readLocalText(path,max=1024*1024){
 if(!statSync(path).isFile()||statSync(path).size>max)throw Error('INVALID_LOCAL_FILE');
 const bytes=readFileSync(path);if(bytes.length>max)throw Error('INVALID_LOCAL_FILE');return bytes.toString('utf8');
}
export const readLocalJson=path=>parseStrictJson(readLocalText(path));
export function verifyWorkbenchRequest(request){
 const {request_fingerprint,assignment_mode,handoff_policy,...input}=request;
 const verified=createGptContentRequest(input);
 if(verified.request_fingerprint!==request_fingerprint||verified.assignment_mode!==assignment_mode||verified.handoff_policy!==handoff_policy)throw Error('REQUEST_FINGERPRINT_MISMATCH');
 return verified;
}
export function makeBriefRequest(options,{now=Date.now(),priorRequest=null}={}){
 const ttl=Number(options['ttl-minutes']??60);if(!Number.isSafeInteger(ttl)||ttl<1||ttl>1440)throw Error('INVALID_DEADLINE_MINUTES');
 const brief=readLocalText(options['brief-file'],80000).trim();
 const source=options['source-file']?readLocalText(options['source-file'],40000):null;
 return createGptContentRequest({schema_version:1,task_id:options.task,current_owner:options.owner,producer:'GPT',workspace:options.workspace,account_id:options.account,source_id:options.source,
  request_revision:Number(options['request-revision']??1),content_revision:Number(options['content-revision']??1),visual_revision:Number(options['visual-revision']??1),previous_revision:options['previous-revision']??null,
  created_at:new Date(now).toISOString(),deadline_at:new Date(now+ttl*60000).toISOString(),
  bridge_ref:{marker:'bridge-task:v1',protocol_version:'2.0',transport:'SLACK_FIRST',slack_channel_id:'C0C6PRGNGLQ',thread_ts:options.thread},
  input:{kind:'image_text',platform:'facebook',brief:source===null?brief:brief+'\n\n明确提供的参考正文：\n'+source,language:options.language,source_refs:source===null?[]:[{source_id:options.source,revision:options['source-revision'],sha256:sha256(Buffer.from(source))}]}
 },{priorRequest});
}
export function reviewLocalContent(request,result,root,{now=Date.now()}={}){
 verifyWorkbenchRequest(request);
 if(now<Date.parse(request.created_at))throw Error('INVALID_INSPECTION_TIME');
 if(now>=Date.parse(request.deadline_at))throw Error('RESULT_EXPIRED');
 if(!result)return {status:'WAITING_FOR_RESULT',publish_allowed:false,owner_changed:false,message:'尚未提供结果；仅导出了请求包，未派送或调用模型。'};
 const inspection=inspectGptContentResult(request,result,{now});
 if(inspection.status!=='REVIEW_REQUIRED')return inspection;
 if(!root)throw Error('LOCAL_INBOX_REQUIRED');
 const manifest=readLocalJson(join(root,'publisher-manifest.json'));
 if(manifest.status!=='READY'||!Array.isArray(manifest.items))throw Error('INVALID_LOCAL_MANIFEST');
 const candidate=readGptDriveInbox(root,manifest).find(row=>row.articleId===request.source_id);
 if(!candidate)throw Error('INBOX_RESULT_MISSING');
 const binding=bindGptResultToInbox(request,result,candidate,{workspace:request.workspace,account_id:request.account_id},{now});
 // Same previousVersion/revision fields consumed by the current gptReviewArticle UI.
 const old=candidate.previousVersion;
 return {...binding,scope_is_caller_declared:true,preview:{article_id:candidate.articleId,inbox_status:candidate.reviewStatus,
  before:old?{title:old.title,body:old.body,content_revision:old.contentRevision,visual_revision:old.visualRevision,image_sha256:old.imageHash}:null,
  after:{title:candidate.title,body:candidate.body,content_revision:candidate.revisionNumber,visual_revision:candidate.visualRevision,image_sha256:candidate.assets[0].sha256},
  changed:{title:!old||old.title!==candidate.title,body:!old||old.body!==candidate.body,image:!old||old.imageHash!==candidate.assets[0].sha256}},
  image_path:candidate.assets[0].path};
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderLocalQa(report){
 if(report.status!=='REVIEW_REQUIRED'||!report.preview)throw Error('RESULT_NOT_REVIEWABLE');
 const bytes=readFileSync(report.image_path);if(sha256(bytes)!==report.preview.after.image_sha256)throw Error('PREVIEW_IMAGE_CHANGED');
 const mime=bytes[0]===137?'image/png':bytes[0]===255?'image/jpeg':'image/webp';
 const version=(label,value)=>value?`<section><h2>${label} · 正文 ${value.content_revision} / 图片 ${value.visual_revision}</h2><h3>${escape(value.title)}</h3><pre>${escape(value.body)}</pre><p>图片 SHA256 ${escape(value.image_sha256)}</p></section>`:'<section><h2>旧版</h2><p>首次投稿，无已批准旧版。</p></section>';
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>内容人工 QA 预览</title><style>body{font:16px sans-serif;max-width:1100px;margin:32px auto;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.versions{display:grid;grid-template-columns:1fr 1fr;gap:24px}img{max-width:100%;max-height:600px}section{border:1px solid #ccc;padding:16px}</style><h1>REVIEW_REQUIRED · ${escape(report.preview.article_id)}</h1><p>本地预览，不是审核通过或发布许可。账号／目录映射由调用者声明，未通过服务端认证。</p><p>差异：标题 ${report.preview.changed.title?'已变':'未变'}；正文 ${report.preview.changed.body?'已变':'未变'}；图片 ${report.preview.changed.image?'已变':'未变'}。</p><div class="versions">${version('旧版（原任务保持冻结）',report.preview.before)}${version('新版（待审核）',report.preview.after)}</div><h2>新版实际图片</h2><img alt="待人工视觉审核的主图" src="data:${mime};base64,${bytes.toString('base64')}"><h2>仍需人工完成</h2><ul><li>核对内容事实与来源。</li><li>检查图片文字、布局及与正文的一致性；如图片有变，回原审核界面对照旧图。</li><li>在原客户资料库审核界面重新读取最新版本并明确批准；企业资料库的 GPT 禁止批准规则保持有效。</li></ul><p>此文件是生成时快照，不回写清单、不批准、不创建发布任务。</p></html>`;
}
