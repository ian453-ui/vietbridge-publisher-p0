import { randomUUID } from "node:crypto";

export const WORKSPACES = [
  {id:"ws-vietbridge",name:"VietBridge",brand:"VietBridge Group",project:"驻越经营实录",health:"正常",channels:["Facebook","公众号","小红书","视频号"]},
  {id:"ws-abc",name:"ABC Manufacturing",brand:"ABC 制造",project:"越南工厂增长",health:"正常",channels:["Facebook","公众号"]},
  {id:"ws-xyz",name:"XYZ Recruitment",brand:"XYZ 招聘",project:"越南人才招聘",health:"会话失效",channels:["Facebook","小红书"]}
];

const titles=["越南工厂订单翻倍，现金为何更紧？","300小时加班不是默认额度","谁控制模具，谁承担供应链风险？","利润能汇出，不等于证据链完整","越南标签责任如何划分？","中国制造商越南扩厂检查表","招聘旺季的身份核验风险","工厂火灾后的连续经营清单","保税区发票常见误区","越南本地组装的原产地判断","跨客户公共政策派生演示","集团内容待分配"];
export const CONTENT = titles.map((title,i)=>({id:`content-${String(i+1).padStart(2,"0")}`,workspaceId:i===11?null:WORKSPACES[i%3].id,title,revision:`r${1+(i%3)}`,hash:`mock-${i+1}-sha256`,status:i===7?"CONTENT_CHANGED":i===8?"RULES_CHANGED":i===11?"UNASSIGNED":"READY",trainingValue:7+(i%5),socialValue:6+(i%6),variants: i%4===0?["Facebook"]:["Facebook","公众号","小红书"]}));

const taskStates=["READY","PROCESSING","PUBLISHED","UNKNOWN","NEEDS_REVIEW"];
export const TASKS=Array.from({length:20},(_,i)=>({id:`task-${String(i+1).padStart(2,"0")}`,workspaceId:WORKSPACES[i%3].id,contentId:CONTENT[i%12].id,platform:["Facebook","公众号","小红书","视频号"][i%4],state:i===3?"UNKNOWN":i===6?"PROCESSING":taskStates[i%taskStates.length],reason:i===3?"提交后连接中断，必须先对账":i===6?"视频正在平台处理":"",identityOk:i!==9,executionProfileOk:i!==10,revisionValid:i!==12,readback:i%5===2}));

export const GROUPS=[
  {id:"g1",workspaceId:"ws-vietbridge",name:"越南中资企业经营圈",language:"中文",cooling:"7天",match:92},
  {id:"g2",workspaceId:"ws-vietbridge",name:"越南工厂管理交流",language:"中文",cooling:"5天",match:88},
  {id:"g3",workspaceId:"ws-abc",name:"Vietnam Manufacturing Network",language:"英文",cooling:"7天",match:83},
  {id:"g4",workspaceId:"ws-xyz",name:"Vietnam HR Community",language:"越/英文",cooling:"3天",match:90},
  {id:"g5",workspaceId:"ws-xyz",name:"在越招聘与用工",language:"中文",cooling:"5天",match:86}
];

export const COMMENTS=Array.from({length:15},(_,i)=>({id:`comment-${i+1}`,workspaceId:WORKSPACES[i%3].id,author:`访客 ${i+1}`,text:i%5===0?"可以帮我们判断具体情况吗？":i%4===0?"这个结论适用于所有企业吗？":"这条很实用，先收藏。",intent:i%5===0?"POTENTIAL_LEAD":i%4===0?"RISK_QUESTION":"ACKNOWLEDGEMENT",state:i===4?"HUMAN_HANDOFF":"DISCOVERED"}));
export const LEADS=[{id:"lead-1",workspaceId:"ws-vietbridge",source:"comment-1",state:"待确认"},{id:"lead-2",workspaceId:"ws-xyz",source:"comment-6",state:"已识别"}];

export function initialState(){return {mode:"agency",workspaceId:null,route:"today",scenario:null,workspaces:structuredClone(WORKSPACES),content:structuredClone(CONTENT),tasks:structuredClone(TASKS),groups:structuredClone(GROUPS),comments:structuredClone(COMMENTS),leads:structuredClone(LEADS),audit:[]};}

export function visible(state,list){return state.mode==="agency"?list:list.filter(x=>x.workspaceId===state.workspaceId);}
export function switchWorkspace(state,workspaceId){const active=state.tasks.some(t=>t.workspaceId===state.workspaceId&&["COMPOSER_READY","SUBMITTED","PROCESSING","UNKNOWN"].includes(t.state));if(state.mode==="workspace"&&active) return {ok:false,code:"ACTIVE_EXECUTION",message:"当前客户有执行中的任务，请先完成、取消或安全对账。"};state.mode="workspace";state.workspaceId=workspaceId;state.route="today";return {ok:true};}
export function canExecute(state,task){if(state.mode!=="workspace")return block("AGENCY_EXECUTION_BLOCKED","跨客户总览不能执行发布或回复，请先进入单一客户。 ");if(task.workspaceId!==state.workspaceId)return block("WRONG_WORKSPACE","任务客户与当前客户不一致，已在写入前阻止。 ");if(!task.identityOk)return block("WRONG_IDENTITY","实际登录身份与任务要求不一致，已在写入前阻止。 ");if(!task.executionProfileOk)return block("WRONG_EXECUTION_PROFILE","执行环境与任务账号不一致，已在写入前阻止。 ");if(!task.revisionValid)return block("PREFLIGHT_INVALIDATED","内容、媒体或群规则已变化，请重新审核。 ");if(task.state==="UNKNOWN")return block("RECONCILE_FIRST","平台可能已经收到提交，必须先核对，不能直接重试。 ");return {ok:true};}
export function reconcile(state,taskId,found){const task=state.tasks.find(t=>t.id===taskId);if(!task||task.state!=="UNKNOWN")return block("NOT_RECONCILABLE","任务当前不需要对账。 ");task.state=found?"PUBLISHED":"NEEDS_REVIEW";task.reason=found?"已通过独立回读确认":"未发现结果；需要人工确认后才能创建新 Attempt";state.audit.unshift({id:randomUUID(),at:new Date().toISOString(),event:"RECONCILED",taskId,result:task.state});return {ok:true,task};}
export function injectScenario(state,scenario){state.scenario=scenario;const task=state.tasks.find(t=>t.workspaceId===(state.workspaceId||"ws-vietbridge"))||state.tasks[0];const map={wrong_workspace:()=>{task.workspaceId=task.workspaceId==="ws-abc"?"ws-xyz":"ws-abc"},wrong_identity:()=>{task.identityOk=false},wrong_profile:()=>{task.executionProfileOk=false},chrome_disconnected:()=>{task.state="NEEDS_REVIEW";task.reason="Chrome 已断开；任务已保存，重连后重新核验身份"},partial_text:()=>{task.state="NEEDS_REVIEW";task.reason="中文正文回读不完整，未提交"},media_failed:()=>{task.state="NEEDS_REVIEW";task.reason="媒体添加失败，未提交"},submit_unknown:()=>{task.state="UNKNOWN";task.reason="提交结果不确定，必须先对账"},video_processing:()=>{task.state="PROCESSING";task.reason="视频处理中，禁止重复上传"},rule_changed:()=>{task.revisionValid=false;task.reason="群规则变化，原 Preflight 已失效"},content_changed:()=>{task.revisionValid=false;task.reason="正文版本变化，原审批已失效"},token_expired:()=>{task.state="NEEDS_REVIEW";task.reason="授权已失效；重新连接后再检查能力"}};map[scenario]?.();return task;}
function block(code,message){return {ok:false,code,message};}
