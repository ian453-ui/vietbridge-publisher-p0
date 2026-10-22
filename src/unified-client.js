import {contentVersionLabel} from './publication-selection.js';
import {PublisherFormDrafts,publisherPayload} from './publisher-form-state.js';
const formDrafts=new PublisherFormDrafts();
const platformDrafts=new Map();
let platformDraft;
export function preservePublisherPlatform(){
 const root=document.querySelector('#unified-publisher');
 const platform=root?.querySelector('#unified-platform')?.value;
 if(root&&platform){platformDraft={workspace:root.dataset.workspace,platform};platformDrafts.set(root.dataset.workspace,platformDraft);}
}

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Page-memory read-only reports. Scope and frozen version are never inferred from a response. */
export class DiagnosticReportCache {
  constructor(){this.values=new Map();this.context='';this.epoch=0;this.jobs=new Set();this.sequence=0;}
  contextKey(workspace,account){return JSON.stringify([workspace,account]);}
  key(job,kind){return JSON.stringify([job.workspace,job.account_id,job.id,job.snapshot_hash,kind]);}
  activate(workspace,account){const key=this.contextKey(workspace,account);if(key===this.context)return;this.context=key;this.epoch++;this.jobs.clear();for(const value of this.values.values())if(value.loading){value.loading=false;value.error='客户或账号已切换；本次读取已停止，请重新读取。';}}
  register(jobs){this.jobs=new Set(jobs.filter(j=>this.contextKey(j.workspace,j.account_id)===this.context).flatMap(j=>['diagnostic','observation'].map(kind=>this.key(j,kind))));for(const [key,value] of this.values)if(value.loading&&!this.jobs.has(key)){value.loading=false;value.error='任务冻结版本已改变；请读取当前版本。';}}
  begin(job,kind){const key=this.key(job,kind);if(!this.jobs.has(key)||this.contextKey(job.workspace,job.account_id)!==this.context)throw Error('请切换至此任务的冻结客户与账号');const value=this.values.get(key)||{};Object.assign(value,{loading:true,error:'',sequence:++this.sequence});this.values.set(key,value);while(this.values.size>200)this.values.delete(this.values.keys().next().value);return {key,sequence:value.sequence,epoch:this.epoch};}
  finish(ticket,{value,error},now=Date.now()){const entry=this.values.get(ticket.key);if(!entry||ticket.epoch!==this.epoch||ticket.sequence!==entry.sequence||!this.jobs.has(ticket.key))return false;entry.loading=false;entry.error=error||'';if(value){entry.value=value;entry.readAt=now;}return true;}
  get(job,kind){return this.values.get(this.key(job,kind));}
}
const diagnosticReports=new DiagnosticReportCache();
export function diagnosticReportText(entry,now=Date.now()){
  if(!entry)return '尚未读取持久报告；点击读取仅查看已有记录，不启动诊断。';
  const lines=[];
  if(entry.loading)lines.push('正在读取已有记录（GET）；不会启动新的平台诊断。');
  if(entry.error)lines.push('读取失败：'+entry.error);
  if(entry.value){const v=entry.value;lines.push('已有记录 · '+v.state+(v.result?.conclusion?' / '+v.result.conclusion:''));if(v.id)lines.push('运行 ID：'+v.id);lines.push('运行开始：'+(v.createdAt||'无')+'；记录更新：'+(v.updatedAt||'无'));lines.push('最近成功读取：'+new Date(entry.readAt).toISOString()+'（距今 '+Math.max(0,Math.floor((now-entry.readAt)/1000))+' 秒）');lines.push('这是上述时间的持久记录；读取和重绘不会启动新诊断，也不证明当前平台状态或允许重发。');lines.push(JSON.stringify(v,null,2));}
  return lines.join('\n');
}

const platforms={facebook:'Facebook',xiaohongshu:'小红书',wechat_official_account:'微信公众号草稿',wechat_channels:'视频号'};
const states={DRAFT:'待确认图文',READY:'已确认 · 待发布',PREPARING:'准备图文中',SUBMITTING:'已请求发布 · 正在回读',UNKNOWN:'结果待核对 · 禁止重发',BLOCKED:'阻断待人工审核',CANCELLED:'已结束任务',PUBLISHED:'已发布 · 平台回读确认',DRAFT_WRITTEN:'草稿已写入 · 未发表',PUBLISHED_ID_PENDING:'已确认发表 · 公开 ID 待取得'};
/** A maintenance response allows local preparation, never implies submission. */
export function maintenancePreparationView(value,mode){
 if(mode!=='read-only'||!Array.isArray(value?.jobs))return value;
 return {...value,localPreparationOnly:true,jobs:value.jobs.map(job=>({...job,canExecute:false,execution:{...job.execution,canExecute:false,reason:'当前仅可准备本地图文，平台提交未开放'}}))};
}
export function draftVersionButtons(job,localPreparationOnly=false){
 if(job.state!=='DRAFT')return '';
 const automatic=localPreparationOnly?'':`<button class="primary" data-approve-auto="${esc(job.id)}">确认版本并检查发布资格</button>`;
 return automatic+`<button data-approve="${esc(job.id)}">仅确认版本（稍后手动发布）</button>`;
}
export function taskOperatorButtons(job){
 const running=['PREPARING','SUBMITTING'].includes(job.state),closed=job.evidence?.operatorFinished;
 const retry=!closed&&(['BLOCKED','UNKNOWN'].includes(job.state)||job.state==='READY'&&job.canExecute);
 const manual=['DRAFT','READY','BLOCKED','UNKNOWN'].includes(job.state);
 return `<div class="task-operator-actions"><button data-retry="${esc(job.id)}" ${retry?'':'disabled'}>${job.state==='UNKNOWN'?'重试（先只读核对）':'重试'}</button><button data-finish="${esc(job.id)}" ${running||closed?'disabled':''}>结束任务</button><button data-manual-complete="${esc(job.id)}" ${manual?'':'disabled'}>登记外部手工作品并核验</button></div>${closed?'<p>已结束处理；历史发布结果与待核对记录仍保留。</p>':''}`;
}
export function publisherJobView(job,accountId,contents=[]){
 const matches=job.account_id===accountId,versionLabel=contentVersionLabel(contents.find(c=>c.id===job.content_id)||{id:job.content_id,title:job.snapshot.title});
 return {...job,versionLabel,viewAccountMismatch:!matches,canExecute:matches&&job.canExecute,execution:matches?job.execution:{...job.execution,canExecute:false,reason:'请切换至此任务的明确发布账号后操作'}};
}
export function confirmationScope(job) {
  const s=job.snapshot;
  return {job_id:job.id,content_id:job.content_id,workspace:job.workspace,account_id:job.account_id,operator_actor_id:s.operatorActorId,target_page_id:s.targetPageId,platform:s.platform,transport:s.transport,snapshot_hash:job.snapshot_hash,media_count:s.media.length};
}
export function maintenanceDiagnosticCanStart(job,accountId){
  const capability=job.readOnlyDiagnostic;
  if(job.account_id!==accountId||job.state!=='UNKNOWN'||job.snapshot.platform!=='facebook'||job.snapshot.transport!=='BROWSER'||capability?.canStart!==true||capability.operation!=='FACEBOOK_READ_ONLY_DIAGNOSTIC')return false;
  const scope=confirmationScope(job),actual=capability.scope;
  return !!actual&&Object.keys(actual).length===Object.keys(scope).length&&Object.keys(scope).every(key=>scope[key]===actual[key]);
}
export function validateExecutionConfirmation(job,capability,now=Date.now()) {
  const expected=confirmationScope(job),actual=capability.scope;
  if(capability.canExecute!==true||capability.state!=='READY'||capability.attemptId)throw Error(capability.reason||'任务已不可执行，请只读核对状态');
  if(!actual||Object.keys(actual).length!==Object.keys(expected).length||Object.keys(expected).some(key=>actual[key]!==expected[key]))throw Error('任务范围或冻结版本已改变，请重新核对');
  if(capability.mode==='TASK_CONFIRM'&&(capability.scopeHash!==job.execution?.scopeHash||JSON.stringify(capability.actionScope)!==JSON.stringify(job.execution?.actionScope)||capability.expiresAt!==job.execution?.expiresAt||Date.parse(capability.expiresAt)<=now))throw Error('当前任务正文、媒体、动作或许可期限已改变');
  if(capability.mode!==job.execution?.mode)throw Error('执行许可方式已改变');
  if(capability.mode==='SINGLE_USE'&&(capability.permitStatus!=='AVAILABLE'||capability.permitId!==job.execution.permitId||capability.expiresAt!==job.execution.expiresAt||!Number.isFinite(Date.parse(capability.expiresAt))||Date.parse(capability.expiresAt)<=now))throw Error('单次许可已改变、过期或消费，不能执行');
}
/** Model shared by the visible dialog and deterministic tests. No submit on open/cancel. */
export class ExecutionConfirmation {
  constructor({job,isCurrent,readCapability,submit,readback,onAttempt=()=>{},now=()=>Date.now()}){Object.assign(this,{job,isCurrent,readCapability,submit,readback,onAttempt,now});this.open=false;this.busy=false;this.sent=false;}
  show(){if(this.sent||this.busy||!this.isCurrent())return false;this.open=true;return true;}
  cancel(){this.open=false;}
  async confirm(){
    if(!this.open||this.busy||this.sent)return false;
    this.busy=true;
    try {
      const capability=await this.readCapability();
      if(!this.open||!this.isCurrent())throw Error('页面、账号或任务已切换，本次确认已失效');
      validateExecutionConfirmation(this.job,capability,this.now());
      this.onAttempt();this.sent=true;this.open=false;
      try {await this.submit(capability);}finally{await this.readback();}
      return true;
    }finally{this.busy=false;}
  }
}
export function executionConfirmationView(job,manual=false) {
  const s=job.snapshot,label=manual?'确认并手动触发发布':job.execution?.mode==='SINGLE_USE'?'确认并执行一次':s.platform==='wechat_official_account'?'确认并自动写入草稿':'确认并自动发布';
  return `<h2 id="execution-confirmation-title">确认执行此任务${job.execution?.mode==='SINGLE_USE'?'一次':''}</h2><p>只有点击“${esc(label)}”才会提交。取消或按 Esc 不会发布。</p>
    <dl><dt>客户</dt><dd>${esc(job.workspace)}</dd><dt>账号</dt><dd>${esc(s.expectedIdentity)} · ${esc(job.account_id)}</dd><dt>Actor</dt><dd>${esc(s.operatorActorId||s.externalId)}</dd><dt>目标 Page／平台身份</dt><dd>${esc(s.targetPageId||s.externalId)}</dd><dt>平台／方式</dt><dd>${esc(s.platform)} · ${esc(s.transport)}</dd><dt>任务</dt><dd>${esc(job.id)}</dd><dt>内容／冻结 hash</dt><dd>${esc(job.content_id)}<br>${esc(job.snapshot_hash)}</dd><dt>许可有效至</dt><dd>${esc(job.execution?.expiresAt||'按当前任务执行权限核对')}</dd></dl>
    ${job.execution?.mode==='TASK_CONFIRM'?`<p>此次动作：Page 发布一次；每日最多 1 条。媒体字节 hash：</p><pre>${esc(JSON.stringify(job.execution.actionScope.media_hashes))}</pre>`:job.execution?.mode==='PAGE_INTERACTIVE'?'<p>这是新建任务的单次人工确认。北京时间 07:00 起算的运营日，同一 Page 最多一次发布尝试；结果不明时不会重试。</p>':''}${job.versionLabel?`<p>${esc(job.versionLabel)}</p>`:''}<h3>冻结正文</h3><pre>${esc(s.body)}</pre><p>媒体：${s.media.length} 项</p><pre>${esc(s.media.join('\n'))}</pre>
    <p data-confirm-status role="status" aria-live="polite"></p><button type="button" data-confirm-cancel>取消</button><button type="button" data-confirm-submit>${esc(label)}</button>`;
}
export function executionButton(job) {
  if(job.state!=='READY')return '';
  const allowed=job.canExecute===true;
  const label=(job.execution?.mode==='SINGLE_USE'?'执行此任务一次':job.snapshot?.platform==='wechat_official_account'?'确认并自动写入草稿':'确认并自动发布');
  return `<button data-execute="${esc(job.id)}" ${allowed?'':'disabled'}>${label}</button>${job.execution?.expiresAt?`<small>单次许可有效至 ${esc(job.execution.expiresAt)}</small>`:''}${!allowed&&job.execution?.reason?`<p>${esc(job.execution.reason)}</p>`:''}`;
}
export function publicationPreviewView(payload,mediaUrls=[],platform='facebook'){
 return `<h2 id="publication-preview-title">完整图文预览 · ${esc(platforms[platform])}</h2>${platform==='wechat_official_account'?'<p>仅写入公众号草稿，不公开发表。</p>':''}<h3>${esc(payload.title||'')}</h3>${payload.versionLabel?`<p>${esc(payload.versionLabel)}</p>`:''}${payload.blockedReason?`<p role="alert">${esc(payload.blockedReason)}</p>`:''}<pre>${esc(payload.body||'此平台尚无公开正文')}</pre><div class="media-preview">${mediaUrls.map(({url,video},i)=>video?`<video controls preload="none" src="${esc(url)}"></video>`:`<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="已绑定媒体 ${i+1}"></a>`).join('')}</div><button type="button" data-preview-close>关闭预览</button>`;
}
export function unifiedAccountManagerView(workspace,profiles=[],accounts=[]){
  return `<section class="panel" id="unified-account-manager" data-workspace="${esc(workspace)}"><details><summary>配置当前客户的平台账号（使用现有授权）</summary>
    <form id="unified-account-form"><label>平台<select name="platform">${Object.entries(platforms).filter(([p])=>p!=='facebook').map(([p,name])=>`<option value="${p}">${name}</option>`).join('')}</select></label>
    <label>账号记录<select name="id"><option value="">新增账号</option>${accounts.filter(a=>a.platform!=='facebook').map(a=>`<option value="${esc(a.id)}">${esc(a.display_name)} · ${esc(platforms[a.platform])}</option>`).join('')}</select></label>
    <label>显示名称<input name="display_name" required></label><label>已核实的平台身份<input name="external_id" required placeholder="小红书 username:名称；公众号 App ID；视频号实际 ID"></label>
    <label>实际显示身份<input name="expected_identity" required></label><label>浏览器平台的专用执行环境<select name="profile_id">${profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
    <label>现有公众号授权文件<input name="config_url" placeholder="本机私有文件绝对路径；不能填写凭据值"></label>
    <label>已有小红书 MCP 端点<input name="mcp_endpoint" placeholder="http://127.0.0.1:18060/mcp"></label>
    <label>已有公众号连接器入口<input name="connector_entry" placeholder="本机 JS 绝对路径"></label>
    <label>视频号合集（可选）<input name="collection"></label><label><input type="checkbox" name="profile_identity_confirmed">我已在此视频号专用窗口核实上述身份；界面无身份文本时使用此确认</label>
    <p data-platform-profile-help>小红书沿用现有MCP连接，无需填写Chrome环境；浏览器平台必须选择其原环境。</p><button>保存平台账号</button><p>Facebook 账号继续在“账号与授权”配置。这里登记已有连接，不创建凭据；先在账号与授权配置专用执行环境。</p>
    </form></details><p id="unified-account-status" role="status"></p></section>`;
}

export function unifiedPublisherView(workspace,account,contents=[],profiles=[],accounts=[],sourceView='') {
  platformDraft=platformDrafts.get(workspace);
  const previewPlatform=platformDraft?.platform||account?.platform||'facebook';
  if(!workspace)return '<section class="panel empty">请选择客户与运营账号。</section>';
  if(!account)return `<section class="panel" id="unified-no-account" data-workspace="${esc(workspace)}">${sourceView}<h2>2. 选择共享内容并完整预览</h2><label>发布平台（与账号配置分开）<select id="unified-platform">${Object.entries(platforms).map(([p,name])=>`<option value="${p}">${name}</option>`).join('')}</select></label><label>发布账号<select aria-label="发布账号" disabled><option>尚未选择当前客户的操作账号</option></select></label><p role="status">请选择当前客户的操作账号；未配置时先在账号与授权登记明确身份。仍可预览共享内容。</p><label>选择共享内容<select id="unified-content">${contents.map(c=>`<option value="${esc(c.id)}">${esc(contentVersionLabel(c))}</option>`).join('')}</select></label><button id="unified-preview" ${contents.length?'':'disabled'}>预览完整图文</button><button disabled>创建发布预览（待确认）</button></section>`;
  return `<section class="panel" id="unified-publisher" data-workspace="${esc(workspace)}" data-account="${esc(account.id)}" data-platform="${esc(previewPlatform)}">
    ${sourceView}<h2>2. 选择共享内容并完整预览</h2>
    <details><summary>当前账号的连接与发布方式</summary><button id="unified-inspect-account">只读核对当前账号与连接</button>
    ${!account.platform||account.platform==='facebook'?`<label>新任务发布方式<select id="unified-transport"><option value="BROWSER" ${account.publisher_transport!=='API'?'selected':''}>浏览器</option><option value="API" ${account.publisher_transport==='API'?'selected':''}>API</option></select></label>
    <label>现有 API 授权配置文件地址（切换 API 时使用）<input id="unified-credential-ref" placeholder="本机绝对路径；不要填写 token 或密码"></label><button id="unified-switch-transport">保存发布方式</button>`:`<p>${esc(platforms[account.platform])} · ${esc(account.publisher_transport)}${account.platform==='xiaohongshu'?' · '+esc(account.publisher_options?.mcp_endpoint||'')+' · 无需Chrome环境':''}${account.platform==='wechat_official_account'?' · 仅入草稿，不公开发表':''}</p>`}
    </details><p>先核对冻结版本并确认，再明确执行发布。提交结果不明确时先核对，不会自动换模式重发。</p>
    <details><summary>手工接入云端内容版本（可选）</summary><form id="unified-content-form"><h3>接入云端内容版本</h3>
      <label>云端内容编号<input name="source_id" required></label><label>版本<input name="revision" required></label>
      <label>标题<input name="title"></label><label>正文<textarea name="body" required></textarea></label>
      <label>媒体引用（每行一个）<textarea name="media"></textarea></label><button>保存内容版本</button>
    </form></details>
    <button type="button" id="unified-recommend-next">推荐下一篇未发布内容</button><label>选择共享内容<select id="unified-content">${contents.map(c=>`<option value="${esc(c.id)}">${esc(contentVersionLabel(c))}</option>`).join('')}</select></label>
    <label>本平台标题<input id="unified-payload-title"></label><label>本平台正文／公众号 Markdown<textarea id="unified-payload-body"></textarea></label><label>话题（每行一个，不带 #）<textarea id="unified-payload-tags"></textarea></label><label>公众号作者<input id="unified-payload-author" value="驻越经营实录"></label>
    <div id="unified-media-preview" class="media-preview"></div><button type="button" id="unified-preview">预览完整图文</button><h2>3. 选择发布平台与明确账号</h2><label>发布平台（与账号配置分开）<select id="unified-platform">${Object.entries(platforms).map(([p,name])=>`<option value="${p}" ${p===previewPlatform?'selected':''}>${name}</option>`).join('')}</select></label><label>发布账号<select id="unified-target-account" aria-label="发布账号">${previewPlatform!==(account.platform||'facebook')?'<option value="">请选择发布账号</option>':''}${accounts.filter(a=>a.enabled&&(a.platform||'facebook')===previewPlatform).map(a=>`<option value="${esc(a.id)}" ${a.id===account.id?'selected':''}>${esc(a.display_name)}</option>`).join('')}</select></label><p id="unified-platform-status" role="status"></p><p id="unified-target-identity">${previewPlatform===(account.platform||'facebook')?esc(account.display_name):'当前平台尚未选择明确目标账号'}</p><p>内容库由当前客户共享；任务对应下面明确选择的平台账号。</p><p id="unified-entry-status" role="status"></p><p id="unified-create-reason" role="status"></p>
    <button id="unified-create" ${(!account.platform||account.platform==='facebook')&&account.identity_type!=='PAGE'||!contents.length?'disabled':''}>创建${account.platform==='wechat_official_account'?'草稿':'发布'}预览（待确认）</button>
    <label><input type="checkbox" id="unified-all-accounts">查看当前客户全部账号的任务</label>
    <p id="unified-status" role="status"></p><h3>4. 当前账号的待确认任务与发布结果</h3><div id="unified-jobs"></div>
  </section>`;
}

export async function mountUnifiedPublisher({workspace,account,token,executionEnabled=false,onChanged,contents=[],accounts=[],preferredContentId,pendingLibrarySelection=false,isCurrent=()=>true,maintenanceMode}) {
  diagnosticReports.activate(workspace,account?.id);
  const manager=document.getElementById('unified-account-manager'),form=manager?.querySelector('#unified-account-form');
  if(manager?.dataset.workspace===workspace&&form){
    const status=manager.querySelector('#unified-account-status');
    const platformFields=()=>{form.elements.profile_id.disabled=form.elements.platform.value==='xiaohongshu';};form.elements.platform.onchange=platformFields;platformFields();
    form.elements.id.onchange=()=>{const a=accounts.find(a=>a.id===form.elements.id.value);if(!a){form.reset();platformFields();return;}for(const key of ['platform','display_name','external_id','expected_identity','profile_id','config_url'])form.elements[key].value=a[key]||'';for(const key of ['mcp_endpoint','connector_entry','collection'])form.elements[key].value=a.publisher_options?.[key]||'';form.elements.profile_identity_confirmed.checked=a.publisher_options?.profile_identity_confirmed===true;platformFields();};
    form.onsubmit=async event=>{event.preventDefault();if(maintenanceMode==='read-only'){status.textContent='当前维护门禁未开放账号配置';return;}if(!manager.isConnected||!isCurrent())return;const button=form.querySelector('button');button.disabled=true;
      try{const input=Object.fromEntries(new FormData(form));if(!input.id)delete input.id;
        const fields=input.platform==='xiaohongshu'?['mcp_endpoint']:input.platform==='wechat_official_account'?['connector_entry']:['collection'];
        input.publisher_options=Object.fromEntries(fields.filter(k=>input[k]).map(k=>[k,input[k]]));if(input.platform==='wechat_channels')input.publisher_options.profile_identity_confirmed=form.elements.profile_identity_confirmed.checked;
        const response=await fetch(`/api/unified/workspaces/${encodeURIComponent(workspace)}/accounts`,{method:'POST',headers:{'content-type':'application/json','x-local-token':token},body:JSON.stringify(input)}),value=await response.json();if(!response.ok)throw Error(value.error||'保存失败');
        if(manager.isConnected)await onChanged();
      }catch(error){if(manager.isConnected)status.textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}
    };
  }
  const empty=document.getElementById('unified-no-account');
  if(!account&&empty?.dataset.workspace===workspace){
    const contentSelect=empty.querySelector('#unified-content'),platformSelect=empty.querySelector('#unified-platform');
    if(contents.some(c=>c.id===preferredContentId))contentSelect.value=preferredContentId;
    empty.querySelector('#unified-preview').onclick=()=>{
      const content=contents.find(c=>c.id===contentSelect.value),platform=platformSelect.value,payload=publisherPayload(content,platform);
      let media=[];try{media=payload.blockedReason?[]:content?.platform_payloads?.[platform]?.media||JSON.parse(content?.media_json||'[]');}catch{}
      const mediaUrls=media.map((path,index)=>({video:/\.mp4$/i.test(path),url:'/api/group-library/content-media?workspace='+encodeURIComponent(workspace)+'&contentId='+encodeURIComponent(contentSelect.value)+'&index='+index+'&platform='+encodeURIComponent(platform)}));
      const dialog=document.createElement('dialog');dialog.className='execution-confirmation';dialog.setAttribute('aria-labelledby','publication-preview-title');dialog.innerHTML=publicationPreviewView(payload,mediaUrls,platform);empty.append(dialog);
      const close=()=>{dialog.close();dialog.remove();};dialog.querySelector('[data-preview-close]').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.showModal();
    };
  }
  const root=document.getElementById('unified-publisher');
  if(!account||!root||root.dataset.workspace!==workspace||root.dataset.account!==account.id)return;
  const contextCurrent=()=>root.isConnected&&isCurrent()&&document.getElementById('ws')?.value===workspace;
  const status=root.querySelector('#unified-status'),jobs=root.querySelector('#unified-jobs');
  if(maintenanceMode==='read-only'){root.querySelector('#unified-entry-status').textContent='当前可选用资料、预览并创建本地待确认任务；平台提交、账号配置和新的平台核对未开放。';for(const selector of ['#unified-inspect-account','#unified-switch-transport']){const button=root.querySelector(selector);if(button){button.disabled=true;button.title='当前维护门禁未开放此操作';}}}
  const prefix=`/api/unified/workspaces/${encodeURIComponent(workspace)}`;
  async function request(path,input) {
    if(!contextCurrent())throw Error('客户范围已改变，未发送请求');
    const response=await fetch(prefix+path,input===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-local-token':token},body:JSON.stringify(input)});
    const data=await response.json();if(!contextCurrent())throw Error('客户范围已改变，已丢弃旧响应');if(!response.ok)throw Error(data.error||'请求失败');return maintenancePreparationView(data,response.headers?.get?.('x-publisher-maintenance'));
  }
  async function run(button,fn,{enableAfter=true}={}) {
    button.disabled=true;try{await fn();}catch(error){if(root.isConnected)status.textContent=error.message;}finally{if(contextCurrent()&&button.isConnected&&enableAfter){if(button.id==='unified-create')fillPayload();else button.disabled=false;}}
  }
  let revision=0,progressTimer,progressBudget=20;
  function reportContextCurrent(){const current=document.getElementById('unified-publisher');return current&&current.dataset.workspace===workspace&&current.dataset.account===account.id&&document.getElementById('ws')?.value===workspace&&current.querySelector('#unified-target-account')?.value===account.id&&document.getElementById('operating-account')?.value===account.id;}
  function paintReports(){const current=document.getElementById('unified-publisher');if(!reportContextCurrent())return;for(const [kind,attribute] of [['diagnostic','data-diagnostic-report'],['observation','data-observation-report']])for(const node of current.querySelectorAll('['+attribute+']')){const job=visibleReportJobs.find(j=>j.id===node.getAttribute(attribute));if(job&&node.dataset.snapshotHash===job.snapshot_hash&&diagnosticReports.jobs.has(diagnosticReports.key(job,kind)))node.textContent=diagnosticReportText(diagnosticReports.get(job,kind));}}
  let visibleReportJobs=[];
  let activeConfirmation;
  const attempted=new Set(),attemptKey=job=>`publisher-execution-attempt:${job.id}:${job.snapshot_hash}`;
  const wasAttempted=job=>{try{return attempted.has(job.id)||sessionStorage.getItem(attemptKey(job))==='sent';}catch{return attempted.has(job.id);}};
  function closeConfirmation(){activeConfirmation?.();activeConfirmation=null;}
  function showConfirmation(button,job,manual=false){
    if(!contextCurrent()||job.account_id!==account.id||root.querySelector('#unified-target-account').value!==account.id||root.dataset.platform!==(job.snapshot.platform||'facebook')){status.textContent='请先选回此任务的发布平台和账号';return;}
    if(activeConfirmation||wasAttempted(job)||!root.isConnected)return;
    const dialog=document.createElement('dialog');dialog.className='execution-confirmation';dialog.setAttribute('aria-labelledby','execution-confirmation-title');dialog.setAttribute('aria-modal','true');dialog.innerHTML=executionConfirmationView(job,manual);root.append(dialog);
    const generation=revision,confirm=dialog.querySelector('[data-confirm-submit]'),cancel=dialog.querySelector('[data-confirm-cancel]'),message=dialog.querySelector('[data-confirm-status]');
    const current=()=>root.isConnected&&dialog.isConnected&&root.dataset.workspace===workspace&&root.dataset.account===account.id&&root.dataset.platform===(job.snapshot.platform||'facebook')&&generation===revision;
    const model=new ExecutionConfirmation({job,isCurrent:current,readCapability:()=>request(`/jobs/${encodeURIComponent(job.id)}/execution-capability`),submit:capability=>{progressBudget=20;return request(`/jobs/${encodeURIComponent(job.id)}/execute`,capability.mode==='TASK_CONFIRM'?{confirm:true,scope_hash:capability.scopeHash}:capability.mode==='PAGE_INTERACTIVE'?{confirm:true,snapshot_hash:job.snapshot_hash}:{});},readback:()=>loadJobs(),onAttempt:()=>{attempted.add(job.id);try{sessionStorage.setItem(attemptKey(job),'sent');}catch{};}});
    const observer=new MutationObserver(()=>{if(!current())cleanup();});
    function cleanup(){model.cancel();observer.disconnect();dialog.close();dialog.remove();if(button.isConnected&&!model.sent)button.disabled=false;if(activeConfirmation===cleanup)activeConfirmation=null;}
    activeConfirmation=cleanup;button.disabled=true;
    cancel.onclick=cleanup;dialog.addEventListener('cancel',event=>{event.preventDefault();cleanup();});
    confirm.onclick=async()=>{if(model.busy||model.sent)return;confirm.disabled=true;message.textContent='正在只读复核任务与许可…';try{await model.confirm();if(model.sent)cleanup();}catch(error){if(root.isConnected)status.textContent=(model.sent?'提交结果需核对，不会自动重试。':'未提交：')+error.message;if(dialog.isConnected){message.textContent=error.message;confirm.disabled=true;}if(model.sent)cleanup();}};
    model.show();dialog.showModal();cancel.focus();observer.observe(document.getElementById('app')||document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-workspace','data-account','data-platform']});
  }
  root.querySelector('#unified-inspect-account').onclick=event=>run(event.currentTarget,async()=>{const result=await request(`/accounts/${encodeURIComponent(account.id)}/inspect`,{});if(root.isConnected)status.textContent=result.healthy?'已核实当前平台身份：'+result.externalId+(result.identityEvidence?' · '+result.identityEvidence:''):result.reason||'需检查登录或连接';});
  async function loadJobs() {
    clearTimeout(progressTimer);closeConfirmation();
    if(!contextCurrent()||root.dataset.platform!==(account.platform||'facebook')){jobs.innerHTML='<p>请选择此平台的明确账号后查看对应任务。</p>';return;}
    const requestRevision=++revision,all=root.querySelector('#unified-all-accounts').checked;
    const response=await request('/jobs'+(all?'':'?accountId='+encodeURIComponent(account.id))),result={...response,jobs:response.jobs.map(job=>publisherJobView(job,account.id,contents))};
    if(!contextCurrent()||requestRevision!==revision||root.dataset.platform!==(account.platform||'facebook')||root.querySelector('#unified-target-account').value!==account.id)return;
    visibleReportJobs=result.jobs;diagnosticReports.register(result.jobs);
    jobs.innerHTML=result.jobs.map(job=>`<article class="panel" data-publisher-account="${esc(job.account_id)}"><b>${esc(job.versionLabel)} · ${esc(states[job.state]||job.state)}</b>
      <p>${esc(platforms[job.snapshot.platform||'facebook'])} · ${esc(job.snapshot.expectedIdentity)} · ${esc(job.snapshot.externalId)} · ${esc(job.snapshot.transport)}</p>
      ${job.viewAccountMismatch?'<p>此任务属于另一发布账号；切换至该明确账号后才能操作。</p>':''}${job.evidence.humanConfirmation?`<p>已记录人工确认 · ${job.evidence.verified?'平台已核验':'等待平台核验，不会自动重发'}</p>`:''}
      <details><summary>核对冻结正文与媒体</summary><pre>${esc(job.snapshot.body)}</pre><pre>${esc(job.snapshot.media.join('\n'))}</pre></details>
      ${draftVersionButtons(job,result.localPreparationOnly)}
      ${executionButton(wasAttempted(job)?{...job,canExecute:false,execution:{...job.execution,reason:'本页面已发送一次执行请求；只读核对结果，不自动重试'}}:job)}
      ${job.browserReopen?.state==='AVAILABLE'?`<button data-browser-reopen="${esc(job.id)}">重新打开原专用浏览器（已授权一次）</button>`:job.browserReopen?.state==='STARTED'?'<p>原专用浏览器已启动；请仅用只读诊断核对身份与历史，不会自动发布。</p>':''}
      ${job.state==='UNKNOWN'?`<label>平台作品 ID（缺回执时填写）<input data-platform-id="${esc(job.id)}"></label><button data-reconcile="${esc(job.id)}">只读核对平台结果</button>${job.snapshot.platform==='facebook'&&job.snapshot.transport==='BROWSER'?`<button data-diagnose="${esc(job.id)}">只读诊断（保留现场，不改任务）</button><button data-diagnostic-refresh="${esc(job.id)}">读取诊断进度与证据</button><button data-observe-composer="${esc(job.id)}">只读观察保留编辑器（不操作表单）</button><button data-observation-refresh="${esc(job.id)}">读取编辑器观察证据</button><pre data-observation-report="${esc(job.id)}" data-snapshot-hash="${esc(job.snapshot_hash)}" role="status" aria-live="polite"></pre><pre data-diagnostic-report="${esc(job.id)}" data-snapshot-hash="${esc(job.snapshot_hash)}" role="status" aria-live="polite"></pre>`:''}`:''}
      ${job.state==='UNKNOWN'&&job.evidence.stage==='PREPARING'&&job.evidence.submissionIntent===false&&job.evidence.browserDiagnostics?.finalClickAttempted===false?`<button data-resolve-preparation="${esc(job.id)}">人工核对准备中断（没有最终提交）</button>`:''}
      ${job.state==='BLOCKED'&&!job.evidence.preparationResolution&&!job.evidence.preparationEffectsMayRemain?`<button data-reopen="${esc(job.id)}">修复条件后重新审核</button>`:''}
      ${job.canResumePrepared===true?`<button data-resume-prepared="${esc(job.id)}">核对并继续原已准备任务</button>`:''}
      ${job.evidence.url?`<a target="_blank" rel="noopener" href="${esc(job.evidence.url)}">查看平台作品</a>`:''}
      ${job.evidence.error?`<p>${esc(job.evidence.error)}</p>`:''}
      ${['DRAFT','READY','BLOCKED'].includes(job.state)?`<button data-cancel="${esc(job.id)}">取消任务</button>`:''}
      ${taskOperatorButtons(job)}
      </article>`).join('')||'<p>当前范围没有发布任务。</p>';
    if(result.localPreparationOnly){for(const button of jobs.querySelectorAll('[data-reconcile],[data-reopen],[data-resume-prepared],[data-retry],[data-finish],[data-manual-complete],[data-cancel],[data-diagnose],[data-observe-composer],[data-resolve-preparation]')){const job=result.jobs.find(j=>j.id===button.dataset.diagnose),allowed=job&&maintenanceDiagnosticCanStart(job,account.id);button.disabled=!allowed;button.title=allowed?'仅启动此冻结任务的只读诊断；保留任务历史，不提交平台':'当前维护门禁未开放此操作；历史记录保留';}if(result.jobs.some(job=>maintenanceDiagnosticCanStart(job,account.id)))root.querySelector('#unified-entry-status').textContent='此冻结任务可手动启动只读诊断；不会提交、重发或改写任务结果。';}
    jobs.querySelectorAll('[data-browser-reopen]').forEach(button=>button.onclick=()=>{
      const job=result.jobs.find(j=>j.id===button.dataset.browserReopen),cap=job.browserReopen;
      if(activeConfirmation||!root.isConnected||!reportContextCurrent())return;
      const dialog=document.createElement('dialog');dialog.className='execution-confirmation';dialog.innerHTML=`<h2>重新打开原专用浏览器</h2><p>用户已授权此专用浏览器重开一次。只启动 Chrome 空白页；不填写、提交或重发任务。可能需要正常登录，不能恢复或证明历史编辑框状态。</p><dl><dt>任务／冻结 hash</dt><dd>${esc(job.id)}<br>${esc(job.snapshot_hash)}</dd><dt>客户／账号</dt><dd>${esc(workspace)}<br>${esc(account.id)}</dd><dt>Actor／Business Page</dt><dd>${esc(cap.scope.operator_actor_id)} / ${esc(cap.scope.target_page_id)}</dd><dt>原目录／loopback 端口</dt><dd>${esc(cap.scope.profile_dir)}<br>127.0.0.1:${esc(cap.scope.cdp_port)}</dd><dt>权限有效至</dt><dd>${esc(cap.expiresAt)}</dd></dl><p data-reopen-status role="status"></p><button data-reopen-cancel>取消</button><button data-reopen-confirm>启动已授权的原浏览器一次</button>`;root.append(dialog);
      let sent=false;const current=()=>root.isConnected&&dialog.isConnected&&reportContextCurrent();
      const observer=new MutationObserver(()=>{if(!current())cleanup();});function cleanup(){observer.disconnect();dialog.close();dialog.remove();if(activeConfirmation===cleanup)activeConfirmation=null;}
      activeConfirmation=cleanup;observer.observe(document.getElementById('app'),{childList:true,subtree:true});dialog.querySelector('[data-reopen-cancel]').onclick=cleanup;dialog.addEventListener('cancel',e=>{e.preventDefault();cleanup();});
      dialog.querySelector('[data-reopen-confirm]').onclick=async event=>{if(sent||!current())return;sent=true;event.currentTarget.disabled=true;
        try{const fresh=await request(`/jobs/${encodeURIComponent(job.id)}/browser-reopen`);if(!current()||fresh.state!=='AVAILABLE'||fresh.authorizationId!==cap.authorizationId||fresh.attemptId!==job.attempt_id||fresh.expiresAt!==cap.expiresAt||Date.parse(fresh.expiresAt)<=Date.now()||!fresh.scope||Object.keys(fresh.scope).length!==Object.keys(cap.scope).length||Object.keys(cap.scope).some(k=>fresh.scope[k]!==cap.scope[k]))throw Error('原浏览器重开范围或单次权限已失效');
          const value=await request(`/jobs/${encodeURIComponent(job.id)}/browser-reopen`,{authorization_id:fresh.authorizationId,scope:fresh.scope,attempt_id:fresh.attemptId,confirm:true});cleanup();if(root.isConnected){status.textContent='原专用浏览器启动结果：'+value.stage+'；尚未核验平台身份，不会自动诊断或发布。';await loadJobs();}
        }catch(error){if(dialog.isConnected)dialog.querySelector('[data-reopen-status]').textContent=error.message;}
      };dialog.showModal();
    });
    jobs.querySelectorAll('[data-approve]').forEach(button=>button.onclick=()=>run(button,async()=>{
      const job=result.jobs.find(j=>j.id===button.dataset.approve);
      await request(`/jobs/${encodeURIComponent(job.id)}/approve`,{snapshot_hash:job.snapshot_hash});await loadJobs();
    }));
    jobs.querySelectorAll('[data-approve-auto]').forEach(button=>button.onclick=()=>run(button,async()=>{const job=result.jobs.find(j=>j.id===button.dataset.approveAuto);await request('/jobs/'+encodeURIComponent(job.id)+'/approve',{snapshot_hash:job.snapshot_hash});const fresh=await loadJobs(),ready=fresh?.jobs.find(j=>j.id===job.id),next=jobs.querySelector('[data-execute="'+job.id+'"]');if(ready?.canExecute&&next)showConfirmation(next,ready);else if(root.isConnected)status.textContent=ready?.execution?.reason||'任务暂不可发布，请核对状态';}));
    jobs.querySelectorAll('[data-cancel]').forEach(button=>button.onclick=()=>run(button,async()=>{
      await request(`/jobs/${encodeURIComponent(button.dataset.cancel)}/cancel`,{});await loadJobs();
    }));
    jobs.querySelectorAll('[data-resolve-preparation]').forEach(button=>button.onclick=()=>{
      const job=result.jobs.find(j=>j.id===button.dataset.resolvePreparation);if(activeConfirmation||!root.isConnected)return;
      const dialog=document.createElement('dialog');dialog.className='execution-confirmation';dialog.setAttribute('aria-labelledby','preparation-confirmation-title');dialog.innerHTML=`<h2 id="preparation-confirmation-title">人工核对准备中断</h2><p>确认已检查准备中断记录：未调用最终提交。上传、草稿或旧编辑器可能残留。本操作仅阻断旧任务、保留审计，不重发或清理平台。</p><dl><dt>任务</dt><dd>${esc(job.id)}</dd><dt>Attempt</dt><dd>${esc(job.attempt_id)}</dd><dt>冻结 hash</dt><dd>${esc(job.snapshot_hash)}</dd><dt>阶段／最终点击</dt><dd>${esc(job.evidence.stage)} · 未尝试最终点击</dd><dt>Actor</dt><dd>${esc(job.snapshot.operatorActorId)}</dd><dt>账号／目标</dt><dd>${esc(job.account_id)} · ${esc(job.snapshot.targetPageId)}</dd></dl><p data-recovery-status role="status"></p><button data-recovery-cancel>取消</button><button data-recovery-confirm>确认准备中断并保留旧任务</button>`;root.append(dialog);
      const generation=revision,current=()=>root.isConnected&&dialog.isConnected&&root.dataset.workspace===workspace&&root.dataset.account===account.id&&root.dataset.platform==='facebook'&&generation===revision;let sent=false;
      const observer=new MutationObserver(()=>{if(!current())cleanup();});function cleanup(){observer.disconnect();dialog.close();dialog.remove();if(activeConfirmation===cleanup)activeConfirmation=null;if(button.isConnected)button.disabled=false;}activeConfirmation=cleanup;button.disabled=true;dialog.querySelector('[data-recovery-cancel]').onclick=cleanup;dialog.addEventListener('cancel',e=>{e.preventDefault();cleanup();});
      dialog.querySelector('[data-recovery-confirm]').onclick=async e=>{if(sent||!current())return;sent=true;e.currentTarget.disabled=true;try{await request(`/jobs/${encodeURIComponent(job.id)}/resolve-preparation`,{acknowledge_preparation_effects:true,expected_attempt_id:job.attempt_id,snapshot_hash:job.snapshot_hash});cleanup();await loadJobs();}catch(error){if(dialog.isConnected)dialog.querySelector('[data-recovery-status]').textContent=error.message;if(root.isConnected)status.textContent=error.message;}};
      dialog.showModal();dialog.querySelector('[data-recovery-cancel]').focus();observer.observe(document.getElementById('app')||document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-workspace','data-account','data-platform']});
    });
    jobs.querySelectorAll('[data-execute]').forEach(button=>button.onclick=()=>showConfirmation(button,result.jobs.find(j=>j.id===button.dataset.execute)));
    jobs.querySelectorAll('[data-resume-prepared]').forEach(button=>button.onclick=()=>{
      const job=result.jobs.find(j=>j.id===button.dataset.resumePrepared);
      if(!job||job.account_id!==account.id||job.snapshot.platform!=='facebook'||job.snapshot.transport!=='BROWSER')return;
      const dialog=document.createElement('dialog');dialog.className='execution-confirmation';dialog.innerHTML=`<h2>继续原已准备任务</h2><p>系统将重新核对原 Meta 编辑器、账号、正文和图片。只有核对全部通过才会执行一次最终提交；结果不明时不会重试。</p><dl><dt>任务／原 attempt</dt><dd>${esc(job.id)}<br>${esc(job.attempt_id)}</dd><dt>冻结 hash</dt><dd>${esc(job.snapshot_hash)}</dd><dt>目标 Page</dt><dd>${esc(job.snapshot.targetPageId)}</dd></dl><p role="status" data-resume-status></p><button data-resume-cancel>取消</button><button data-resume-confirm>确认并继续原任务</button>`;root.append(dialog);
      let sent=false;const cleanup=()=>{dialog.close();dialog.remove();};dialog.querySelector('[data-resume-cancel]').onclick=cleanup;dialog.addEventListener('cancel',event=>{event.preventDefault();cleanup();});
      dialog.querySelector('[data-resume-confirm]').onclick=async event=>{if(sent)return;sent=true;event.currentTarget.disabled=true;dialog.querySelector('[data-resume-status]').textContent='正在核对原编辑器与平台历史…';
        try{await request(`/jobs/${encodeURIComponent(job.id)}/resume-prepared`,{confirm:true,attempt_id:job.attempt_id,snapshot_hash:job.snapshot_hash});cleanup();await loadJobs();}
        catch(error){if(dialog.isConnected)dialog.querySelector('[data-resume-status]').textContent=error.message+'；不会自动再次提交。';await loadJobs();}
      };
      dialog.showModal();
    });
    jobs.querySelectorAll('[data-retry]').forEach(button=>button.onclick=()=>{
      const job=result.jobs.find(j=>j.id===button.dataset.retry);
      if(job.state==='READY')return showConfirmation(button,job);
      return run(button,async()=>{
        if(job.state==='UNKNOWN'){
          status.textContent='只读核对旧任务，不会再次发布';
          await request('/jobs/'+encodeURIComponent(job.id)+'/reconcile',{});
        }else await request('/jobs/'+encodeURIComponent(job.id)+'/reopen',{});
        await loadJobs();
      });
    });
    jobs.querySelectorAll('[data-finish]').forEach(button=>button.onclick=()=>run(button,async()=>{
      const job=result.jobs.find(j=>j.id===button.dataset.finish);
      if(job.state==='UNKNOWN'){
        if(!window.confirm('结束这条 UNKNOWN 任务的处理？UNKNOWN 与失败审计会保留。只有系统能证明最终提交未调用时，才会释放浏览器占用；结果不明仍需平台核对。'))return;
        await request('/jobs/'+encodeURIComponent(job.id)+'/finish',{});
        await loadJobs();return;
      }
      if(!window.confirm('结束本任务的处理？历史结果会保留，UNKNOWN 仍需核对，不会删除平台作品。'))return;
      await request('/jobs/'+encodeURIComponent(button.dataset.finish)+'/finish',{});await loadJobs();
    }));
    jobs.querySelectorAll('[data-manual-complete]').forEach(button=>button.onclick=()=>run(button,async()=>{
      const job=result.jobs.find(j=>j.id===button.dataset.manualComplete),reference=window.prompt('请填写你已在平台核对的作品链接或作品 ID。公众号仅代表草稿写入，不代表公开发表。');
      if(!reference?.trim())return;
      if(!window.confirm('确认已在 '+job.snapshot.expectedIdentity+' 上核对该冻结稿件及媒体？将记录人工确认，保留旧证据，不会发帖。'))return;
      const input={acknowledge:true,snapshot_hash:job.snapshot_hash,...(/^https?:\/\//i.test(reference.trim())?{url:reference.trim()}:{platform_id:reference.trim()})};
      const reported=await request('/jobs/'+encodeURIComponent(job.id)+'/manual-complete',input);
      try{await request('/jobs/'+encodeURIComponent(job.id)+'/reconcile',{platform_id:reported.evidence.humanConfirmation.platformId||undefined});}
      catch(error){if(root.isConnected)status.textContent='人工确认已记录，但平台核验未通过：'+error.message+'；保留待核对状态，不会重发。';}
      await loadJobs();
    }));
    async function readReport(id,kind){
      const job=result.jobs.find(j=>j.id===id),ticket=diagnosticReports.begin(job,kind);paintReports();
      try{const value=await request(`/jobs/${encodeURIComponent(id)}/${kind==='diagnostic'?'diagnostics':'composer-observation'}`);
        if(!reportContextCurrent())throw Error('客户或账号选择已改变；本次响应已丢弃，请读取当前范围。');
        if(!['NOT_STARTED','RUNNING','DONE'].includes(value.state))throw Error('持久报告状态无效');
        if(value.state!=='NOT_STARTED'){const expected=confirmationScope(job);if(value.jobId!==id||!value.scope||Object.keys(expected).some(key=>value.scope[key]!==expected[key])||kind==='observation'&&value.scope.profile_id!==job.snapshot.profileId)throw Error('持久报告范围与当前冻结任务不匹配');}
        diagnosticReports.finish(ticket,{value});paintReports();return value;
      }catch(error){diagnosticReports.finish(ticket,{error:error.message});paintReports();throw error;}
    }
    const diagnosticProgress=id=>readReport(id,'diagnostic');
    const observationProgress=id=>readReport(id,'observation');
    jobs.querySelectorAll('[data-diagnostic-refresh]').forEach(button=>button.onclick=()=>run(button,()=>diagnosticProgress(button.dataset.diagnosticRefresh)));
    jobs.querySelectorAll('[data-observation-refresh]').forEach(button=>button.onclick=()=>run(button,()=>observationProgress(button.dataset.observationRefresh)));
    paintReports();
    jobs.querySelectorAll('[data-observe-composer]').forEach(button=>button.onclick=()=>run(button,async()=>{const job=result.jobs.find(j=>j.id===button.dataset.observeComposer);const current=()=>root.isConnected&&root.dataset.workspace===workspace&&root.dataset.account===account.id&&job.account_id===account.id;if(!current())throw Error('请切换至此任务的冻结客户与账号');const prior=await observationProgress(job.id);if(!current())throw Error('客户或账号已切换，未启动观察');if(prior.state!=='NOT_STARTED'){status.textContent='已有观察记录；只读取结果，不重复启动。';return;}await request(`/jobs/${encodeURIComponent(job.id)}/composer-observation`,{...confirmationScope(job),profile_id:job.snapshot.profileId});for(let i=0;i<16&&root.isConnected&&button.isConnected;i++){const value=await observationProgress(job.id);if(value.state!=='RUNNING')return;await new Promise(resolve=>setTimeout(resolve,2000));}if(root.isConnected)status.textContent='只读取观察进度，不重复启动。';},{enableAfter:false}));
    jobs.querySelectorAll('[data-diagnose]').forEach(button=>button.onclick=()=>run(button,async()=>{const job=result.jobs.find(j=>j.id===button.dataset.diagnose);if(result.localPreparationOnly&&!maintenanceDiagnosticCanStart(job,account.id))throw Error('当前维护门禁未开放此冻结任务的只读诊断');await request(`/jobs/${encodeURIComponent(job.id)}/diagnostics`,{snapshot_hash:job.snapshot_hash});for(let i=0;i<45&&root.isConnected&&button.isConnected;i++){const value=await diagnosticProgress(job.id);if(value.state!=='RUNNING')return;await new Promise(resolve=>setTimeout(resolve,2000));}if(root.isConnected)status.textContent='诊断仍在运行或页面已切换；只读取进度，不会再次启动。';},{enableAfter:false}));
    for(const action of ['reconcile','reopen'])jobs.querySelectorAll(`[data-${action}]`).forEach(button=>button.onclick=()=>run(button,async()=>{
      const id=button.dataset[action];
      const job=result.jobs.find(j=>j.id===id);
      const input=action==='reconcile'?{platform_id:root.querySelector(`[data-platform-id="${id}"]`)?.value||undefined}:{};
      try {await request(`/jobs/${encodeURIComponent(id)}/${action}`,input);}finally{await loadJobs();}
    },{enableAfter:action!=='execute'}));
    if(root.dataset.platform!==(account.platform||'facebook'))jobs.querySelectorAll('[data-execute],[data-approve-auto],[data-approve],[data-retry],[data-resolve-preparation]').forEach(button=>button.disabled=true);
    for(const article of jobs.querySelectorAll('[data-publisher-account]'))if(article.dataset.publisherAccount!==account.id)for(const button of article.querySelectorAll('button'))button.disabled=true;
    if(result.jobs.some(job=>['PREPARING','SUBMITTING'].includes(job.state))&&progressBudget-->0)progressTimer=setTimeout(()=>{if(root.isConnected)loadJobs().catch(error=>{if(root.isConnected)status.textContent=error.message;});},2000);
    return result;
  }
  root.querySelector('#unified-all-accounts').onchange=()=>loadJobs().catch(e=>{if(root.isConnected)status.textContent=e.message;});
  if(root.querySelector('#unified-switch-transport'))root.querySelector('#unified-switch-transport').onclick=event=>run(event.currentTarget,async()=>{
    await request(`/accounts/${encodeURIComponent(account.id)}/transport`,{transport:root.querySelector('#unified-transport').value,config_url:root.querySelector('#unified-credential-ref').value||undefined});
    if(root.isConnected)await onChanged();
  });
  root.querySelector('#unified-content-form').onsubmit=event=>{
    event.preventDefault();const form=event.currentTarget,input=Object.fromEntries(new FormData(form));input.media=input.media.split('\n').map(x=>x.trim()).filter(Boolean);
    run(form.querySelector('button'),async()=>{await request('/content',input);if(root.isConnected)await onChanged();});
  };
  const select=root.querySelector('#unified-content'),chosen=formDrafts.resolve(workspace,account.id,preferredContentId,contents);if(chosen){select.value=chosen;select.dataset.userPicked='true';}
  const platformSelect=root.querySelector('#unified-platform'),targetAccountSelect=root.querySelector('#unified-target-account');let mediaUrls=[],previewPayload={};
  const restoredPlatform=platformDraft?.workspace===workspace?platformDraft.platform:undefined;
  if(restoredPlatform&&Object.hasOwn(platforms,restoredPlatform))platformSelect.value=restoredPlatform;
  const fillPayload=()=>{const platform=platformSelect.value,content=contents.find(c=>c.id===select.value),p=pendingLibrarySelection?{}:publisherPayload(content,platform,platform===(account.platform||'facebook')?formDrafts.get(workspace,account.id,select.value):undefined);if(formDrafts.get(workspace,account.id,select.value))select.dataset.userPicked='true';root.querySelector('#unified-payload-title').value=p.title||'';root.querySelector('#unified-payload-body').value=p.body||'';root.querySelector('#unified-payload-tags').value=(p.tags||[]).join('\n');root.querySelector('#unified-payload-author').value=p.author||account.display_name||'';let media=[];try{media=p.blockedReason?[]:content?.platform_payloads?.[platform]?.media||JSON.parse(content?.media_json||'[]')}catch{}previewPayload=p;mediaUrls=media.map((path,index)=>({video:/\.mp4$/i.test(path),url:'/api/group-library/content-media?workspace='+encodeURIComponent(workspace)+'&contentId='+encodeURIComponent(select.value)+'&index='+index+'&platform='+encodeURIComponent(platform)}));const preview=root.querySelector('#unified-media-preview');preview.innerHTML=pendingLibrarySelection?'':media.length?media.map((path,index)=>{const url='/api/group-library/content-media?workspace='+encodeURIComponent(workspace)+'&contentId='+encodeURIComponent(select.value)+'&index='+index+'&platform='+encodeURIComponent(platform);return /\.mp4$/i.test(path)?'<video controls preload="none" src="'+esc(url)+'"></video>':'<a target="_blank" rel="noopener" href="'+esc(url)+'"><img loading="lazy" src="'+esc(url)+'" alt="已绑定图片 '+(index+1)+'"></a>'}).join(''):'<p>本稿未绑定头图或媒体。</p>';const matched=platform===(account.platform||'facebook')&&targetAccountSelect.value===account.id;root.querySelector('#unified-target-identity').textContent=matched?'当前目标：'+account.display_name+' · '+platforms[platform]+' · '+(platform==='facebook'?'Actor '+(account.operator_actor_id||'未核实')+' / Page '+(account.target_page_id||'未核实'):account.external_id||'身份未核实')+' · 账号 '+account.id:'当前平台尚未选择明确目标账号';const reason=platformSelect.disabled?'正在确认账号归属，请稍候':pendingLibrarySelection?'请先选用勾选资料并核对新稿':!matched?(accounts.some(a=>a.enabled&&(a.platform||'facebook')===platform)?'请选择此平台的明确发布账号，再创建预览':'当前客户未配置此平台的可用发布账号；可先预览，不能用其他平台账号发布'):p.blockedReason||(!content?'请选择内容':'');root.querySelector('#unified-create-reason').textContent=reason||'预览图文后创建待确认任务；只有再次确认才会提交。';root.querySelector('#unified-create').textContent=matched?'创建'+platforms[platform]+'预览（待确认）':'选择明确账号后创建待确认任务';root.querySelector('#unified-create').disabled=Boolean(reason)||platform==='facebook'&&account.identity_type!=='PAGE';root.querySelectorAll('#unified-payload-title,#unified-payload-body,#unified-payload-tags,#unified-payload-author').forEach(input=>input.disabled=platform!==(account.platform||'facebook'));};select.onchange=()=>{root.dispatchEvent(new CustomEvent('publisher-content-selected',{bubbles:true,detail:{contentId:select.value,workspace}}));formDrafts.select(workspace,account.id,select.value);fillPayload();};fillPayload();
  root.querySelector('#unified-preview').onclick=()=>{const dialog=document.createElement('dialog');dialog.className='execution-confirmation';dialog.setAttribute('aria-labelledby','publication-preview-title');const payload=platformSelect.value===(account.platform||'facebook')?{...previewPayload,title:root.querySelector('#unified-payload-title').value,body:root.querySelector('#unified-payload-body').value}:previewPayload;dialog.innerHTML=publicationPreviewView({...payload,versionLabel:contentVersionLabel(contents.find(c=>c.id===select.value)||{id:select.value})},mediaUrls,platformSelect.value);root.append(dialog);const close=()=>{dialog.close();dialog.remove();};dialog.querySelector('[data-preview-close]').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.showModal();};
  platformSelect.onchange=async()=>{if(!contextCurrent())return;closeConfirmation();++revision;clearTimeout(progressTimer);const platform=platformSelect.value;platformDraft={workspace,platform};platformDrafts.set(workspace,platformDraft);root.dataset.platform=platform;for(const option of select.options)option.textContent=contentVersionLabel(contents.find(c=>c.id===option.value)||{id:option.value});jobs.innerHTML='<p>请选择此平台的明确账号后查看对应任务。</p>';const matches=accounts.filter(a=>a.enabled&&(a.platform||'facebook')===platform);targetAccountSelect.innerHTML=platform===(account.platform||'facebook')?matches.map(a=>`<option value="${esc(a.id)}" ${a.id===account.id?'selected':''}>${esc(a.display_name)}</option>`).join(''):`<option value="">${matches.length?'请选择发布账号':'尚未配置此平台账号'}</option>`+matches.map(a=>`<option value="${esc(a.id)}">${esc(a.display_name)}</option>`).join('');targetAccountSelect.disabled=!matches.length;fillPayload();if(platform===(account.platform||'facebook')){root.querySelector('#unified-platform-status').textContent='当前发布账号：'+account.display_name;await loadJobs();return;}jobs.querySelectorAll('[data-execute],[data-approve-auto],[data-approve],[data-retry],[data-resolve-preparation]').forEach(button=>button.disabled=true);root.querySelector('#unified-platform-status').textContent=matches.length?'请选择此平台的发布账号；不会自动选择身份。':'当前客户尚无此平台发布账号；可预览内容，发布前需要配置明确身份。';};
  if(restoredPlatform&&restoredPlatform!==(account.platform||'facebook'))platformSelect.onchange();
  targetAccountSelect.onchange=async()=>{if(!contextCurrent())return;closeConfirmation();const selectedPlatform=platformSelect.value,target=accounts.find(a=>a.id===targetAccountSelect.value&&a.enabled&&(a.platform||'facebook')===selectedPlatform);if(!target){status.textContent='请选择此平台的明确发布账号';fillPayload();return;}targetAccountSelect.disabled=true;platformSelect.disabled=true;root.querySelector('#unified-create').disabled=true;jobs.innerHTML='<p>正在加载明确账号的任务；旧任务不可操作。</p>';try{await request('/accounts/select',{id:target.id});if(contextCurrent()&&platformSelect.value===selectedPlatform&&targetAccountSelect.value===target.id)await onChanged({reset:true});}catch(error){if(contextCurrent()){status.textContent=error.message;targetAccountSelect.value='';targetAccountSelect.disabled=false;platformSelect.disabled=false;fillPayload();}}};
  let publicationStates;
  const recommend=async(auto=false)=>{const result=await request('/accounts/'+encodeURIComponent(account.id)+'/content-status');if(!contextCurrent()||root.dataset.platform!==(account.platform||'facebook'))return;publicationStates=result.states;for(const option of select.options){const row=contents.find(c=>c.id===option.value),states=publicationStates[option.value]||[];option.textContent=contentVersionLabel(row||{id:option.value})+(states.includes('HUMAN_CONFIRMED')?' · 人工确认完成':states.includes('PUBLISHED')?' · 已发布':states.includes('DRAFT_WRITTEN')?' · 草稿已写入':states.includes('PUBLISHED_ID_PENDING')?' · 列表已确认/ID待核对':states.some(s=>['PREPARING','SUBMITTING','UNKNOWN','READY'].includes(s))?' · 执行中/待核对':' · 无已确认发布记录');}if(pendingLibrarySelection||select.disabled||auto&&select.dataset.userPicked)return;const next=[...contents].sort((a,b)=>String(a.title||'').localeCompare(String(b.title||''),'zh',{numeric:true})).find(c=>!(publicationStates[c.id]||[]).some(s=>['HUMAN_CONFIRMED','PUBLISHED','DRAFT_WRITTEN','PUBLISHED_ID_PENDING','PREPARING','SUBMITTING','UNKNOWN','READY'].includes(s)));if(next){select.value=next.id;fillPayload();}else if(!auto)status.textContent='没有可推荐的未发布内容；已发布项仍可手工选择。';};
  select.addEventListener('change',()=>select.dataset.userPicked='true');
  root.querySelectorAll('#unified-payload-title,#unified-payload-body,#unified-payload-tags,#unified-payload-author').forEach(input=>input.addEventListener('input',()=>{select.dataset.userPicked='true';formDrafts.set(workspace,account.id,select.value,{title:root.querySelector('#unified-payload-title').value,body:root.querySelector('#unified-payload-body').value,tags:root.querySelector('#unified-payload-tags').value.split('\n').map(x=>x.trim()).filter(Boolean),author:root.querySelector('#unified-payload-author').value});}));
  
  root.querySelector('#unified-recommend-next').onclick=event=>run(event.currentTarget,()=>recommend());
  recommend(true).catch(error=>{if(root.isConnected)status.textContent=error.message;});
  root.querySelector('#unified-create').onclick=event=>run(event.currentTarget,async()=>{
    if(!contextCurrent()||targetAccountSelect.value!==account.id||platformSelect.disabled||platformSelect.value!==(account.platform||'facebook'))throw Error('必须选择此平台的明确发布账号');
    if(previewPayload.blockedReason)throw Error(previewPayload.blockedReason);
    if(pendingLibrarySelection||select.disabled)throw Error('请先选用勾选资料并核对内容');
    await request('/jobs',{account_id:account.id,content_id:select.value,payload:{title:root.querySelector('#unified-payload-title').value,body:root.querySelector('#unified-payload-body').value,tags:root.querySelector('#unified-payload-tags').value.split('\n').map(s=>s.trim()).filter(Boolean),author:root.querySelector('#unified-payload-author').value}});await loadJobs();
  });
  if(pendingLibrarySelection){select.disabled=true;root.querySelector('#unified-create').disabled=true;status.textContent='资料库选择已变更，请先选用勾选资料；不会使用旧稿建立任务。';}
  await loadJobs();
}

// Production inspection preview; retains the original approval gates.
const reviewEscape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const productionReviewView=()=>'<section class="panel"><h2>内容制作审核 · V3</h2><p>查看已保存的正文、媒体及解码结果。所有记录均待审核；事实、视觉、声音和字幕仍需人工核对，原资料库批准门禁继续有效。</p><div id="production-reviews" role="status">正在读取当前客户和账号…</div></section><section class="panel"><h2>指标观测与来源</h2><p>按账号、帖子、定义与时间窗分别显示。合成测试和离线待核证据不代表真实平台指标；采集失败不会沿用旧值。</p><div id="metric-observations" role="status">选择客户与账号后读取。</div></section>';
export async function mountProductionReview({workspace,accountId,token,fetcher=fetch}){
 void mountMetricObservations({workspace,accountId,fetcher});
 const node=document.getElementById('production-reviews');if(!node)return;
 if(!workspace||!accountId){node.textContent='请先选择客户与发布账号。';return;}
 const base='/api/production-reviews',scope=new URLSearchParams({workspace,accountId});
 const read=async url=>{const response=await fetcher(url);if(!response.ok)throw Error('审核读取失败（'+response.status+'）');return response.json();};
 try{
  const {reviews}=await read(base+'?'+scope);if(!node.isConnected)return;
  node.innerHTML=reviews.map(row=>`<details data-production-review="${reviewEscape(row.id)}"><summary>${reviewEscape(row.task_id)} · 请求版本 ${reviewEscape(row.request_revision)} · REVIEW_REQUIRED</summary><div>展开查看完整内容与媒体。</div></details>`).join('')||'<p>当前客户与账号暂无制作审核记录。</p>';
  for(const details of node.querySelectorAll('details'))details.addEventListener('toggle',async()=>{
   if(!details.open||details.dataset.loaded)return;const target=details.querySelector('div');target.textContent='读取中…';
   try{
    const id=details.dataset.productionReview,report=await read(base+'/'+id+'?'+scope);if(!details.isConnected)return;
    target.innerHTML=report.items.map(item=>`<article><h3>${reviewEscape(item.source_id)} · 正文 ${item.content_revision} / 视觉 ${item.visual_revision}</h3>${item.artifacts.map(a=>{
     const url=base+'/'+id+'/asset?'+scope+'&source='+encodeURIComponent(item.source_id)+'&artifact='+encodeURIComponent(a.artifact_id);
     const media=a.kind==='video'?`<video controls preload="metadata" src="${reviewEscape(url)}" class="production-review-media"></video>`:a.kind==='cover'?`<img src="${reviewEscape(url)}" alt="待人工审核图片" class="production-review-media">`:`<pre data-review-text="${reviewEscape(url)}">读取正文中…</pre>`;
     return `<section><h4>${reviewEscape(a.artifact_id)} · ${reviewEscape(a.kind)}</h4><p>${reviewEscape(a.validation.level)} · SHA256 ${reviewEscape(a.sha256)}</p>${a.kind==='video'?'<p>已全流解码；浏览器播放、音画质量和字幕对齐待人工验收。</p>':''}${media}</section>`;
    }).join('')}</article>`).join('');
    for(const pre of target.querySelectorAll('[data-review-text]')){const response=await fetcher(pre.dataset.reviewText);if(!response.ok)throw Error('正文读取失败');const text=await response.text();if(pre.isConnected)pre.textContent=text;}
    if(details.isConnected&&report.approval)mountProductionDecision(details,target,report.approval,{base,scope,token,fetcher,read});
    details.dataset.loaded='true';
   }catch(error){if(details.isConnected)target.textContent=error.message;}
  });
 }catch(error){if(node.isConnected)node.textContent=error.message;}
}

function mountProductionDecision(details,target,initial,{base,scope,token,fetcher,read}){
 const section=document.createElement('section');section.dataset.productionApproval='';target.append(section);
 const labels={PENDING:'此版本待人工决定',CONTENT_APPROVED:'此版本内容已批准 · 不授权发布',CONTENT_REJECTED:'此版本内容已拒绝',REVOKED:'旧批准已撤销 · 需要重新审核',BLOCKED:'审批入口未开放'};
 const checks={CONTENT_FACTS:'已核对正文事实和来源',VISUAL_QA:'已检查图像文字、布局与正文的一致性',VIDEO_PLAYBACK_AND_SUBTITLE_ALIGNMENT:'已检查视频音画与字幕（如有）',ORIGINAL_SOURCE_REVIEW:'已核对原始资料；原资料库批准门禁仍需独立满足'};
 const path=base+'/'+details.dataset.productionReview+'?'+scope;
 async function refresh(){const report=await read(path);if(details.isConnected)render(report.approval);}
 function render(approval){
  section.innerHTML=`<h3>人工内容决定</h3><p data-approval-state="${reviewEscape(approval.state)}">${reviewEscape(labels[approval.state]||approval.state)}</p><p>${approval.provenance==='SYNTHETIC_FIXTURE'?'合成制作方流程验收；不是真实制作方认证。':'真实制作方认证不可用，批准保持禁用。'} 原内容审核与各账号发布授权仍独立保留。</p><p>目标平台：${reviewEscape(approval.target_platforms.join('、')||'未知')}${approval.blocked_reason?' · '+reviewEscape(approval.blocked_reason):''}</p><div data-approval-controls></div><button type="button" data-approval-refresh>刷新审批状态</button><p data-approval-notice role="status"></p><details><summary>审批审计（${approval.history.length}${approval.history_truncated?'+':''} 条）</summary>${approval.history.map(e=>`<p>${reviewEscape(e.created_at)} · ${reviewEscape(e.kind)} · ${reviewEscape(e.actor_id==='SYSTEM_VALIDATOR'?'系统失效检查':'已认证管理员')} · ${reviewEscape(e.reason)}</p>`).join('')||'<p>尚无审批事件。</p>'}</details>`;
  const notice=section.querySelector('[data-approval-notice]');section.querySelector('[data-approval-refresh]').onclick=()=>refresh().catch(error=>{if(section.isConnected)notice.textContent=error.message;});
  if(!approval.can_decide||!token)return;
  const controls=section.querySelector('[data-approval-controls]');controls.innerHTML=Object.entries(checks).map(([key,label])=>`<label><input type="checkbox" data-production-check="${key}">${label}</label>`).join('')+'<label>审批说明（拒绝时必填）<textarea data-approval-reason maxlength="1000"></textarea></label><label><input type="checkbox" data-content-only>确认只决定此冻结内容版本，不授权发布或导入</label><button type="button" data-production-decide="APPROVE" disabled>批准此合成版本</button><button type="button" data-production-decide="REJECT" disabled>拒绝此合成版本</button>';
  const values=()=>Object.fromEntries([...controls.querySelectorAll('[data-production-check]')].map(x=>[x.dataset.productionCheck,x.checked]));let busy=false;
  const update=()=>{const confirmed=controls.querySelector('[data-content-only]').checked,reason=controls.querySelector('[data-approval-reason]').value.trim();for(const button of controls.querySelectorAll('[data-production-decide]'))button.disabled=busy||!confirmed||(button.dataset.productionDecide==='APPROVE'?!Object.values(values()).every(Boolean):!reason);};
  controls.addEventListener('input',update);controls.addEventListener('change',update);
  for(const button of controls.querySelectorAll('[data-production-decide]'))button.onclick=async()=>{
   if(busy||!details.isConnected)return;busy=true;update();notice.textContent='正在保存此版本决定…';
   const command={command_id:crypto.randomUUID(),decision:button.dataset.productionDecide,expected_subject:approval.subject_fingerprint,expected_event_id:approval.latest_event_id,reason:controls.querySelector('[data-approval-reason]').value.trim(),checks:values(),confirmation:'CONTENT_ONLY'};
   try{const response=await fetcher(base+'/'+details.dataset.productionReview+'/decision?'+scope,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(command)}),receipt=await response.json();if(!response.ok)throw Error(receipt.error||'审批未接受');await refresh();if(section.isConnected)section.querySelector('[data-approval-notice]').textContent='决定已保存并回读；没有创建发布任务。';}
   catch(error){if(section.isConnected)notice.textContent=error.message+'；请刷新审批状态后再决定。';}
  };
 }
 render(initial);
}

async function mountMetricObservations({workspace,accountId,fetcher}){
 const node=document.getElementById('metric-observations');if(!node)return;if(!workspace||!accountId){node.textContent='请先选择客户与发布账号。';return;}
 const scope=new URLSearchParams({workspace,accountId}),base='/api/metric-observations';let asOf;
 const read=async path=>{const response=await fetcher(path);if(!response.ok)throw Error('指标读取失败（'+response.status+'）');return response.json();};
 const origin=x=>x==='SYNTHETIC'?'合成测试 · 非用户指标':'离线证据 · 真实性待核';
 const windowText=w=>w.kind==='UNKNOWN'?'未知时间窗':w.start+' 至 '+w.end+' · '+(w.timezone||'时区未知');
 const showError=(target,error)=>{if(target.isConnected){const p=document.createElement('p');p.textContent=error.message;target.append(p);}};
 function more(target,label,load){const button=document.createElement('button');button.textContent=label;button.onclick=async()=>{button.disabled=true;try{await load();button.remove();}catch(error){button.disabled=false;showError(target,error);}};target.append(button);}
 async function history(details,cursor=''){
  const target=details.querySelector('[data-metric-history]'),data=await read(base+'/series/'+details.dataset.metricSeries+'?'+scope+'&cursor='+cursor);if(!details.isConnected)return;
  if(!cursor)target.textContent='';
  for(const entry of data.entries){const p=document.createElement('p');p.textContent=entry.observation.observed_at+' · '+entry.observation.metric.availability+' · '+(entry.observation.metric.value===null?'null':entry.observation.metric.value)+' · '+(entry.unavailable_reason||'');const a=document.createElement('a');a.textContent=' 原始证据';a.download='metric-evidence.bin';a.href=base+'/evidence/'+entry.id+'?'+scope;p.append(a);target.append(p);}
  if(!data.entries.length)target.textContent='暂无观测；采集状态仍保留。';
  if(data.next_cursor)more(target,'更多历史记录',()=>history(details,data.next_cursor));
 }
 async function page(cursor=''){
  const report=await read(base+'?'+scope+'&cursor='+cursor+(asOf?'&asOf='+encodeURIComponent(asOf):''));if(!node.isConnected)return;
  asOf=report.as_of;if(!cursor)node.textContent='';
  const section=document.createElement('div');section.innerHTML=report.snapshots.map(row=>`<details data-metric-series="${reviewEscape(row.series_id)}"><summary>${reviewEscape(row.target.task_id)} · ${reviewEscape(row.target.platform)} / ${reviewEscape(row.target.object_id)} · ${reviewEscape(row.selector.metric.name)}：${row.value===null?'不可用':reviewEscape(row.value)} · ${reviewEscape(row.status)}</summary><p>${origin(row.origin)} · 正文 ${reviewEscape(row.target.content_id)} / ${reviewEscape(row.target.content_revision)}</p><p>${reviewEscape(row.selector.metric.definition_text)} (${reviewEscape(row.selector.metric.definition_id)} / ${reviewEscape(row.selector.metric.definition_version)})</p><p>时间窗：${reviewEscape(windowText(row.selector.window))}</p><p>观测时间：${reviewEscape(row.observed_at||'尚无观测')} · 原因：${reviewEscape(row.reason||'无')}</p><div data-metric-history>展开读取历史与证据。</div></details>`).join('')||'<p>当前客户与账号暂无指标观测。</p>';node.append(section);
  for(const details of section.querySelectorAll('[data-metric-series]'))details.addEventListener('toggle',async()=>{if(!details.open||details.dataset.loaded)return;details.dataset.loaded='pending';try{await history(details);details.dataset.loaded='true';}catch(error){delete details.dataset.loaded;showError(details,error);}});
  if(report.next_cursor)more(node,'更多指标序列',()=>page(report.next_cursor));
 }
 try{await page();}catch(error){if(node.isConnected)node.textContent=error.message;}
}
