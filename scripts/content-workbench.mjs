import {mkdirSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {join,extname} from 'node:path';
import {makeBriefRequest,readLocalJson,readLocalText,reviewLocalContent,renderLocalQa,sha256,verifyWorkbenchRequest} from '../src/content-workbench.js';
import {inspectGptContentResult} from '../src/gpt-content-contract.js';
import {readGptDriveInbox} from '../src/gpt-drive-inbox.js';
import {validateImage} from '../src/image-validation.js';
import {createProductionRequest,packageProductionResult,inspectProductionResult} from '../src/production-artifact-contract.js';
import {productionDemo} from './production-artifact-demo.mjs';
const help=`本地内容制作工作台（不派送、不调用模型、不批准、不发布）
request --task ID --owner ORIGINAL_OWNER --workspace ID --account ID --source CONTENT-ID --thread TS --language zh-CN --brief-file brief.txt --out request.json
  可选 --ttl-minutes 60 --source-file reference.txt --source-revision r1
  修订另需 --prior request-old.json --request-revision N --content-revision N --visual-revision N --previous-revision HASH
package-result --request request.json --title TITLE --caption-file caption.txt --image image.png --out NEW_PACKAGE_DIRECTORY
  仅将明确提供的模型产物封装为本地 result.json + schema-v1 submission.json；不证明产物来自 GPT。
review --request request.json [--result result.json --root LOCAL_CLIENT_ROOT --out preview.html]
  root 使用原 publisher-manifest.json / GPT-INBOX 结构；只读。未传 result 会显示缺少结果。
demo --out NEW_DIRECTORY
  一键合成请求→结果→原 inbox 更新差异→REVIEW_REQUIRED；另附过期与旧 revision 失败案例。
production-request --plan plan.json [--prior previous-request.json] --out request.json
production-package --request request.json --selections selections.json --root ARTIFACT_ROOT --out result.json
production-review --request request.json --result result.json --root ARTIFACT_ROOT [--receipt receipt.json]
production-demo --out NEW_DIRECTORY
  非发布多产物：两篇独立知识稿/配图/平台文案＋脚本/字幕/视频；输出可复用 plan 与 selections 示例。
  视频执行 ffprobe 与全流解码，视觉/声音/字幕仍待人工审核；此模式不导入原 inbox。详见 handoff/production-artifacts.md。
所有输出路径必须不存在，避免覆盖。文档：handoff/content-workbench.md`;
function options(args,allowed){const out={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!allowed.includes(key)||Object.hasOwn(out,key)||args[i+1]===undefined||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENTS');out[key]=args[i+1];}return out;}
const save=(path,data)=>writeFileSync(path,data,{flag:'wx'});
const json=value=>JSON.stringify(value,null,2)+'\n';
function packageResult(request,title,caption,image,imageName,{now=Date.now()}={}){
 verifyWorkbenchRequest(request);validateImage(image,extname(imageName));
 const result={...Object.fromEntries(['schema_version','task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id','source_id','content_revision','visual_revision','bridge_ref'].map(k=>[k,request[k]])),completed_at:new Date(now).toISOString(),status:'SUCCEEDED',output:{title,facebook_caption:caption,primary_image_sha256:sha256(image)},error_code:null};
 inspectGptContentResult(request,result,{now});
 return {result,submission:{schema_version:1,status:'READY_FOR_REVIEW',content_id:request.source_id,title,facebook_caption:caption,primary_image:imageName,revision_number:request.content_revision,visual_revision:request.visual_revision,primary_image_sha256:sha256(image)}};
}
function exportPackage(path,packet,image,name){mkdirSync(path);save(join(path,name),image);save(join(path,'submission.json'),json(packet.submission));save(join(path,'result.json'),json(packet.result));}
function demo(out){
 mkdirSync(out);const root=join(out,'synthetic-client');mkdirSync(root);for(const name of ['READY','READY/content','READY/assets','GPT-INBOX'])mkdirSync(join(root,name));
 const image=readFileSync(new URL('../test/fixtures/gpt-primary.png',import.meta.url));
 save(join(root,'READY/content/DEMO-001.md'),'# 合成旧标题\n\n虚构工坊周六活动。\n');save(join(root,'READY/assets/DEMO-001.png'),image);
 const manifest={status:'READY',items:[{content_id:'DEMO-001',status:'READY',title:'合成旧标题',content_revision:1,visual_revision:1,body_source:'READY/content/DEMO-001.md',primary_image:'READY/assets/DEMO-001.png'}]};save(join(root,'publisher-manifest.json'),json(manifest));
 const brief=join(out,'brief.txt');save(brief,'为虚构工坊修改活动文案，明确为周日，不添加未经确认的价格。仅用于离线演示。');
 const opts={task:'SYNTHETIC-CONTENT-DEMO',owner:'MAC_CODEX',workspace:'synthetic-client',account:'synthetic-account',source:'DEMO-001',thread:'1792490400.000001',language:'zh-CN','brief-file':brief,'content-revision':'2'};
 // Build the existing inbox candidate first to derive the same old-version token used by its UI.
 const provisional=makeBriefRequest(opts),packet=packageResult(provisional,'合成新标题','虚构工坊周日活动。具体安排请以确认信息为准。',image,'primary.png');
 const folder=join(root,'GPT-INBOX/result');mkdirSync(folder);save(join(folder,'primary.png'),image);save(join(folder,'submission.json'),json(packet.submission));
 const candidate=readGptDriveInbox(root,manifest)[0];if(candidate.reviewStatus!=='UPDATE_AVAILABLE')throw Error('DEMO_INBOX_FAILED');
 const request=makeBriefRequest({...opts,'previous-revision':candidate.previousRevision});
 const finalPacket=packageResult(request,packet.result.output.title,packet.result.output.facebook_caption,image,'primary.png');
 save(join(out,'request.json'),json(request));save(join(out,'result.json'),json(finalPacket.result));save(join(folder,'result.json'),json(finalPacket.result));
 const report=reviewLocalContent(request,finalPacket.result,root);save(join(out,'preview.html'),renderLocalQa(report));save(join(out,'review.json'),json(report));
 const stale={...finalPacket.result,request_revision:request.request_revision+1};save(join(out,'wrong-revision-result.json'),json(stale));
 const expired=makeBriefRequest(opts,{now:Date.now()-7200000});save(join(out,'expired-request.json'),json(expired));
 return {status:report.status,publish_allowed:false,synthetic_only:true,changed:report.preview.changed,next:'打开 preview.html；失败案例见交接说明。未派送或批准。'};
}
try{
 const [command,...args]=process.argv.slice(2);let output;
 if(command==='--help'&&args.length===0)console.log(help);
 else if(command==='request'){
  const o=options(args,['task','owner','workspace','account','source','thread','language','brief-file','out','ttl-minutes','source-file','source-revision','prior','request-revision','content-revision','visual-revision','previous-revision']);
  const request=makeBriefRequest(o,{priorRequest:o.prior?readLocalJson(o.prior):null});save(o.out,json(request));output={status:'REQUEST_EXPORTED',sent:false,publish_allowed:false,request_fingerprint:request.request_fingerprint};
 }else if(command==='package-result'){
  const o=options(args,['request','title','caption-file','image','out']);if(!statSync(o.image).isFile()||statSync(o.image).size>20000000)throw Error('INVALID_LOCAL_IMAGE');const image=readFileSync(o.image);const name='primary'+extname(o.image).toLowerCase();
  const packet=packageResult(readLocalJson(o.request),o.title,readLocalText(o['caption-file'],80000).trim(),image,name);exportPackage(o.out,packet,image,name);output={status:'RESULT_PACKAGED',producer_authenticated:false,publish_allowed:false};
 }else if(command==='review'){
  const o=options(args,['request','result','root','out']);output=reviewLocalContent(readLocalJson(o.request),o.result?readLocalJson(o.result):null,o.root);
  if(o.out)save(o.out,renderLocalQa(output));
 }else if(command==='demo'){const o=options(args,['out']);output=demo(o.out);}
 else if(command==='production-request'){
  const o=options(args,['plan','prior','out']);const request=createProductionRequest(readLocalJson(o.plan),{priorRequest:o.prior?readLocalJson(o.prior):null});save(o.out,json(request));output={status:'REQUEST_EXPORTED',sent:false,publish_allowed:false,import_allowed:false};
 }else if(command==='production-package'){
  const o=options(args,['request','selections','root','out']);const result=packageProductionResult(readLocalJson(o.request),readLocalJson(o.selections),{root:o.root});save(o.out,json(result));output={status:'RESULT_PACKAGED',producer_authenticated:false,publish_allowed:false,import_allowed:false};
 }else if(command==='production-review'){
  const o=options(args,['request','result','root','receipt']);output=inspectProductionResult(readLocalJson(o.request),readLocalJson(o.result),{root:o.root,priorReceipt:o.receipt?readLocalJson(o.receipt):null});
 }else if(command==='production-demo'){const o=options(args,['out']);output=productionDemo(o.out);}
 else throw Error('INVALID_ARGUMENTS');
 if(output)console.log(json(output));
}catch(error){const code=/^[A-Z_]{3,80}$/.test(error.message)?error.message:error.code==='EEXIST'?'OUTPUT_ALREADY_EXISTS':error.code==='ENOENT'?'LOCAL_FILE_MISSING':'INVALID_LOCAL_INPUT';
 const hints={RESULT_EXPIRED:'请求已过期；回原任务核对，不自动重发。',RESULT_BINDING_MISMATCH:'结果不属于当前请求／revision；保留原件并核对原线程。',INBOX_VERSION_MISMATCH:'旧版或正文／图片版本已改变；刷新原审核资料后重新核对。',INVALID_BRIDGE_REFERENCE:'需原桥已注册的原 owner 与原线程；不能改 owner 绕过。',OUTPUT_ALREADY_EXISTS:'输出已存在；保留原文件，选择新的导出路径。',INBOX_NOT_PENDING_REVIEW:'现有 inbox 判定不可审核；回原资料库检查版本或图片。'};
 console.error('内容工作台停止：'+code+(hints[code]?' · '+hints[code]:''));process.exitCode=1;}
