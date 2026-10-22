const $=selector=>document.querySelector(selector),escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={workspaces:[],accounts:[],contents:[],tasks:[],reviews:[],metrics:[],workspace:'',account:'',previewPlatform:'facebook',targetAccount:'',generation:0};
// Unsaved content stays in this page's memory, scoped exactly like its save command.
const contentDrafts=new Map(),targetReviewCommands=new Map(),variantDrafts=new Map();let variantContext=null,variantKey=null,variantEpoch=0;let editorKey=null,previewEpoch=0;
const scopeKey=()=>state.workspace&&state.account?JSON.stringify([state.workspace,state.account]):null;
function clearPreview(){for(const video of $('#preview-body').querySelectorAll('video'))video.pause();$('#preview-body').replaceChildren();}
function dismissPreview(){++previewEpoch;clearPreview();$('#preview').close();}
function beginPreview(){const epoch=++previewEpoch,generation=state.generation;clearPreview();$('#preview-title').textContent='正在读取…';return ()=>epoch===previewEpoch&&generation===state.generation;}
function stashDraft(){const draft=contentDrafts.get(editorKey);if(draft&&!draft.pending)draft.values=Object.fromEntries(new FormData($('#content-form')));}
function paintDraft(){
 const form=$('#content-form'),draft=contentDrafts.get(editorKey);form.reset();
 for(const [name,value] of Object.entries(draft?.values||{}))form.elements.namedItem(name).value=value;
 for(const field of form.querySelectorAll('input,textarea'))field.readOnly=Boolean(draft?.pending);
 form.querySelector('button[type=submit]').disabled=!editorKey||Boolean(draft?.pending);
}
function detachDraft(){detachVariant();stashDraft();editorKey=null;$('#content-form').hidden=true;paintDraft();}
function bindDraft(){const key=scopeKey();if(key!==editorKey){detachDraft();editorKey=key;if(key&&!contentDrafts.has(key))contentDrafts.set(key,{values:{},command:null,submitted:null,pending:false});}paintDraft();}
const platformNames={facebook:'Facebook',xiaohongshu:'小红书',wechat_official_account:'微信公众号',wechat_channels:'微信视频号'};
function status(message,error=false){$('#status').textContent=message;$('#status').classList.toggle('error',error);}
async function api(path,body){const response=await fetch(path,{credentials:'same-origin',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'读取失败'),{status:response.status});return result;}
function tab(name){dismissPreview();for(const button of document.querySelectorAll('[data-tab]')){if(button.dataset.tab===name)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==name;$('#heading').textContent=$('[data-tab="'+name+'"]').textContent;}
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>tab(button.dataset.tab);
for(const button of document.querySelectorAll('[data-open-settings]'))button.onclick=()=>tab('settings');
function options(select,rows,idKey,labelKey,selected){select.innerHTML='<option value="">请选择</option>'+rows.map(row=>'<option value="'+escape(row[idKey])+'">'+escape(row[labelKey])+'</option>').join('');select.value=selected||'';}
function render(){
 $('#empty').hidden=state.workspaces.length>0;$('#new-content').disabled=!state.account;$('#account-form button').disabled=!state.workspace;
 const account=state.accounts.find(a=>a.account_id===state.account);$('#account-status').textContent=account?'当前账号：'+account.display_name+' · '+platformNames[account.platform]+' · '+account.authorization_state+'。身份及平台授权尚未验证。':'';
 const platform=state.previewPlatform,target=state.accounts.find(a=>a.account_id===state.targetAccount&&a.platform===platform);if(!target)state.targetAccount='';
 $('#content-platform').value=platform;options($('#target-account'),state.accounts.filter(a=>a.platform===platform),'account_id','display_name',state.targetAccount);
 $('#target-status').textContent=target?'冻结目标：'+target.display_name+' · '+platformNames[platform]+' · '+(target.external_identity||'外部身份未核验')+'。仅创建草稿，不授予发布权限。':'可先预览 '+platformNames[platform]+'；冻结前请明确选择该平台的目标账号。没有平台稿时不会借用其他文案。';
 $('#contents').innerHTML=state.contents.map(c=>'<article data-content="'+escape(c.id)+'"><span class="pill">'+(c.review_edit?'编辑稿 · 须重新校验':c.review_binding?'审核准备稿 · 账号绑定':'待来源核验')+' · v'+c.revision+'</span><h3>'+escape(c.title)+'</h3><p>'+escape(c.content_id)+' / '+escape(c.slug)+'</p><p>来源账号：'+escape(state.accounts.find(a=>a.account_id===c.account_id)?.display_name||c.account_id)+'</p><p>'+escape(c.body.length)+' 字符 · '+escape(platformNames[platform])+(c.variants[platform]?' · 明确平台稿':' · 缺少该平台稿')+'</p>'+(c.review_binding?'<p>审批和媒体准备仅绑定来源账号；共享预览不会转移批准。</p>':'')+'<code>SHA256 '+escape(c.payload_hash)+'</code><div><button data-preview="'+escape(c.id)+'" '+(!c.variants[platform]?'disabled':'')+'>完整平台预览</button><button data-freeze="'+escape(c.id)+'" '+(!target||!c.variants[platform]||c.review_binding||c.review_edit?'disabled':'')+'>冻结草稿任务</button><button data-edit-variant="'+escape(c.id)+'" '+(!state.account||c.revision!==c.latest_revision?'disabled':'')+'>编辑所选平台</button></div></article>').join('')||(state.workspace?'<p>当前客户尚无可读取的共享内容版本。可先编写并保存完整内容。</p>':'<p>选择客户后读取共享内容。</p>');
 $('#tasks').innerHTML=state.tasks.map(t=>'<article data-task="'+escape(t.id)+'"><span class="pill">'+escape(t.state)+'</span><h3>'+escape(t.snapshot.payload.title)+'</h3><p>'+escape(platformNames[t.snapshot.platform])+' · '+escape(t.snapshot.content_id)+' / '+escape(t.snapshot.slug)+' · v'+t.snapshot.revision+'</p><code>'+escape(t.snapshot_hash)+'</code><p>无发布权限 · 原尝试：'+escape(t.attempt_id||'尚未执行')+'</p><button data-task-preview="'+escape(t.id)+'">查看冻结内容</button></article>').join('')||'<p>当前账号尚无冻结任务。</p>';
 $('#reviews').innerHTML=state.reviews.map(r=>'<article><span class="pill">'+escape(r.state)+'</span><h3>'+escape(r.task_id)+'</h3><p>请求版本 '+r.request_revision+' · 审批与发布权限分别核验</p><button data-review="'+escape(r.id)+'">查看素材快照</button></article>').join('')||'<p>当前账号没有已入账的制作快照。</p>';
 $('#metrics').innerHTML=state.metrics.map(m=>'<article><span class="pill">'+escape(m.origin)+'</span><h3>'+escape(m.selector.metric.name)+' · '+escape(m.value===null?'—':m.value)+'</h3><p>'+escape(m.status)+' · '+escape(m.reason||'有观测值')+'</p><p>'+escape(m.selector.metric.definition_text)+'</p><p>'+escape(m.selector.window.kind)+' · '+escape(m.selector.window.start||'未知开始')+' → '+escape(m.selector.window.end||'未知结束')+'</p><button data-metric="'+escape(m.series_id)+'">观测历史</button></article>').join('')||'<p>当前账号没有指标观测。真实采集尚未接入。</p>';
 for(const button of document.querySelectorAll('[data-review]'))button.onclick=()=>showReview(button.dataset.review);
 for(const button of document.querySelectorAll('[data-metric]'))button.onclick=()=>showMetric(button.dataset.metric);
 for(const button of document.querySelectorAll('[data-preview]'))button.onclick=()=>{const c=state.contents.find(c=>c.id===button.dataset.preview);if(c.review_edit)showEditedContent(c.id);else if(c.review_binding)showPlan(c.review_binding.plan_id,c.review_binding.account_id);else preview(c.variants[state.previewPlatform],c.body,c.payload_hash);};
 for(const button of document.querySelectorAll('[data-edit-variant]'))button.onclick=()=>openVariant(button.dataset.editVariant,state.previewPlatform);
 for(const button of document.querySelectorAll('[data-task-preview]'))button.onclick=()=>{const t=state.tasks.find(t=>t.id===button.dataset.taskPreview);if(t.snapshot.production_plan)showPlan(t.snapshot.production_plan.id);else preview(t.snapshot.payload,null,t.snapshot_hash);};
 for(const button of document.querySelectorAll('[data-freeze]'))button.onclick=async()=>{
  if(button.disabled)return;button.disabled=true;const c=state.contents.find(c=>c.id===button.dataset.freeze),scope={workspace:state.workspace,account:state.targetAccount,platform:state.previewPlatform},started=state.generation,view=previewEpoch,command=button.dataset.command||(button.dataset.command=crypto.randomUUID());
  const current=()=>scope.workspace===state.workspace&&scope.account===state.account&&scope.account===state.targetAccount&&scope.platform===state.previewPlatform&&started===state.generation&&view===previewEpoch;
  try{await api('/api/sites/workspaces/'+scope.workspace+'/tasks',{command_id:command,account_id:scope.account,content_id:c.id,expected_payload_hash:c.payload_hash,expected_platform:scope.platform});if(current()){const loading=loadScope(),generation=state.generation,epoch=previewEpoch;await loading;if(generation===state.generation&&epoch===previewEpoch){tab('tasks');status('草稿任务已持久保存；未上传或发布。');}}}catch(error){if(current()&&button.isConnected){button.disabled=false;status(error.message+'；结果未知时请先刷新，不自动重试。',true);}}
 };
}
function preview(payload,body,hash){beginPreview();$('#preview-title').textContent='完整平台预览';if(!payload){status('当前平台没有明确稿件，不能沿用其他平台文案。',true);return;}$('#preview-body').innerHTML='<h3>'+escape(payload.title)+'</h3><span class="pill">待核验 · 不授权发布</span><pre>'+escape(payload.body)+'</pre>'+(body?'<details><summary>原完整正文</summary><pre>'+escape(body)+'</pre></details>':'')+'<p><code>'+escape(hash)+'</code></p>';$('#preview').showModal();}
$('#close-preview').onclick=dismissPreview;
$('#preview').addEventListener('cancel',event=>{event.preventDefault();dismissPreview();});
async function loadScope(){dismissPreview();bindDraft();const generation=++state.generation,workspace=state.workspace,account=state.account;state.contents=[];state.tasks=[];state.reviews=[];state.metrics=[];render();if(!workspace)return;
 try{const suffix='?accountId='+encodeURIComponent(account),[contents,tasks,reviews,metrics]=await Promise.all([api('/api/sites/workspaces/'+workspace+'/catalogue'+(account?suffix:'')),account?api('/api/sites/workspaces/'+workspace+'/tasks'+suffix):{tasks:[]},account?api('/api/sites/workspaces/'+workspace+'/reviews'+suffix):{reviews:[]},account?api('/api/sites/workspaces/'+workspace+'/metrics'+suffix):{snapshots:[]}]);if(generation!==state.generation)return;state.contents=contents.contents;state.tasks=tasks.tasks;state.reviews=reviews.reviews;state.metrics=metrics.snapshots;render();status('已读取客户共享内容；任务、制作快照和指标按当前账号分别回读。');}catch(error){if(generation===state.generation)status(error.message+'；当前读取不可用。',true);}}
async function loadAccounts(){dismissPreview();detachDraft();const generation=++state.generation,workspace=state.workspace;state.accounts=[];state.account='';state.contents=[];state.tasks=[];state.reviews=[];state.metrics=[];options($('#account'),[],'account_id','display_name','');render();if(!workspace)return;
 try{const result=await api('/api/sites/workspaces/'+workspace+'/accounts');if(generation!==state.generation)return;state.accounts=result.accounts;const saved=localStorage.getItem('publisher-v3-account:'+workspace);state.account=state.accounts.some(a=>a.account_id===saved)?saved:(state.accounts[0]?.account_id||'');options($('#account'),state.accounts,'account_id','display_name',state.account);await loadScope();}catch(error){if(generation===state.generation)status(error.message,true);}}
async function refresh(){state.targetAccount='';dismissPreview();detachDraft();const generation=++state.generation;try{const result=await api('/api/sites/workspaces');if(generation!==state.generation)return;state.workspaces=result.workspaces;const selected=state.workspace||localStorage.getItem('publisher-v3-workspace');state.workspace=state.workspaces.some(w=>w.id===selected)?selected:(state.workspaces[0]?.id||'');options($('#workspace'),state.workspaces,'id','name',state.workspace);await loadAccounts();if(!state.workspaces.length)status('尚无客户工作区。请先添加客户。');}catch(error){if(generation===state.generation)status(error.message==='IDENTITY_REQUIRED'?'请通过 ChatGPT Sites 登录后使用工作台。':error.message==='SITES_RUNTIME_BINDING_REQUIRED'?'Sites 身份或持久层未接入，数据操作保持关闭。':error.message,true);}}
$('#workspace').onchange=()=>{state.targetAccount='';state.previewPlatform='facebook';detachDraft();state.workspace=$('#workspace').value;localStorage.setItem('publisher-v3-workspace',state.workspace);loadAccounts();};
$('#account').onchange=()=>{state.targetAccount='';detachDraft();state.account=$('#account').value;localStorage.setItem('publisher-v3-account:'+state.workspace,state.account);loadScope();};$('#refresh').onclick=refresh;
$('#content-platform').onchange=()=>{state.previewPlatform=$('#content-platform').value;state.targetAccount='';dismissPreview();render();};
$('#target-account').onchange=()=>{const id=$('#target-account').value;state.targetAccount=id;dismissPreview();if(!id){render();return;}detachDraft();state.account=id;$('#account').value=id;localStorage.setItem('publisher-v3-account:'+state.workspace,id);loadScope();};
$('#new-content').onclick=()=>{$('#content-form').hidden=false;$('#content-form').scrollIntoView({behavior:'smooth'});};$('#cancel-content').onclick=()=>{$('#content-form').hidden=true;};
function form(id,submit){$(id).onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]');if(button.disabled)return;button.disabled=true;const command=form.dataset.command||(form.dataset.command=crypto.randomUUID()),data=Object.fromEntries(new FormData(form));try{await submit(data,command);delete form.dataset.command;form.reset();status('已保存并回读服务端记录。');}catch(error){status(error.message+'；请刷新核对，原命令保留，不自动重试。',true);}finally{button.disabled=false;}};}
form('#workspace-form',async(data,command)=>{const result=await api('/api/sites/workspaces',{command_id:command,name:data.name.trim()});state.workspace=result.id;await refresh();});
form('#account-form',async(data,command)=>{if(!state.workspace)throw Error('请先选择客户');const workspace=state.workspace,result=await api('/api/sites/workspaces/'+workspace+'/accounts',{command_id:command,display_name:data.display_name.trim(),platform:data.platform,external_identity:data.external_identity.trim()||null});if(state.workspace===workspace){localStorage.setItem('publisher-v3-account:'+workspace,result.id);await loadAccounts();}});
$('#content-form').addEventListener('input',stashDraft);
$('#content-form').onsubmit=async event=>{
 event.preventDefault();stashDraft();const key=scopeKey(),draft=contentDrafts.get(key),workspace=state.workspace,accountId=state.account,account=state.accounts.find(a=>a.account_id===accountId);
 if(!account||key!==editorKey||!draft||draft.pending)return;
 const data={...draft.values},encoded=JSON.stringify(data);
 if(draft.command&&draft.submitted!==encoded){status('上次保存结果尚待核对；请恢复原提交内容后使用原命令回读，不能变更原命令的正文。',true);return;}
 const command=draft.command||(draft.command=crypto.randomUUID());draft.submitted=encoded;draft.pending=true;paintDraft();
 try{
  await api('/api/sites/workspaces/'+workspace+'/contents',{command_id:command,account_id:accountId,content_id:data.content_id.trim(),slug:data.slug.trim(),revision:Number(data.revision),title:data.title.trim(),body:data.body.trim(),variants:{[account.platform]:{title:data.title.trim(),body:data.platform_body.trim()}}});
  draft.values={};draft.command=null;draft.submitted=null;
  if(editorKey===key){$('#content-form').hidden=true;await loadScope();if(editorKey===key)status('已保存并回读服务端记录。');}
 }catch(error){
  // 400 is input rejection before the authoring transaction. Ambiguous/storage outcomes keep the original command and payload.
  if(error.status===400){draft.command=null;draft.submitted=null;}
  if(editorKey===key)status(error.message+(error.status===400?'；请修正输入后保存。':'；请刷新核对，原命令和提交内容保留，不自动重试。'),true);
 }
 finally{draft.pending=false;if(editorKey===key)paintDraft();}
};
$('#variant-close').onclick=detachVariant;
$('#variant-form').addEventListener('input',stashVariant);
$('#variant-platform').onchange=()=>{if(!variantContext)return;stashVariant();selectVariant($('#variant-platform').value);};
$('#variant-preview').onclick=()=>{stashVariant();const d=variantDrafts.get(variantKey);if(d)previewVariant(d.base,d.values);};
$('#variant-rebase').onclick=rebaseVariant;
$('#variant-form').onsubmit=saveVariant;
await refresh();

function evidencePath(resource,id){return '/api/sites/workspaces/'+state.workspace+'/'+resource+'/'+id+'?accountId='+encodeURIComponent(state.account);}
function sourceSummary(source){if(!source)return '';const s=source.summary;return '<section id="canonical-source"><h3>来源与版本</h3><p>'+escape(s.content_id)+' · '+escape(s.slug)+'</p><p>快照版本 '+escape(source.source_revision)+' / 当前来源版本 '+escape(source.current_revision)+' · '+escape(source.state)+'</p><p>最新 QA：'+escape(s.qa_status)+' · '+escape(source.blocked_reason||'素材已校验，仍需独立人工审核')+'</p><p>来源记录不代表制作方认证或发布授权。</p></section>';}
async function showReview(id){const current=beginPreview(),generation=state.generation,workspace=state.workspace,account=state.account;try{const [review,approval]=await Promise.all([api(evidencePath('reviews',id)),api(evidencePath('reviews',id+'/approval'))]);if(!current())return;const assetPath=a=>'/api/sites/workspaces/'+workspace+'/reviews/'+id+'/assets/'+encodeURIComponent(a.source_id)+'/'+encodeURIComponent(a.artifact_id)+'?accountId='+encodeURIComponent(account);
 $('#preview-title').textContent='制作素材快照';$('#preview-body').innerHTML='<p>审核目标：'+escape(state.accounts.find(a=>a.account_id===account)?.display_name||account)+' · '+escape(platformNames[state.accounts.find(a=>a.account_id===account)?.platform]||'')+'</p><h3>'+escape(review.task_id)+'</h3><p>'+escape(approval.state)+' · '+(approval.can_decide?'仅限合成素材内容审核 · 不授予发布许可':escape(approval.blocked_reason||'来源或管理员未接入')+' · 不能批准或发布')+'</p>'+sourceSummary(review.source_import)+review.assets.map(a=>'<section class="review-asset"><p>'+escape(a.source_id)+' / '+escape(a.artifact_id)+' · '+escape(a.state)+'</p>'+(a.mime.startsWith('image/')?'<img alt="已入账的素材快照" src="'+escape(assetPath(a))+'">':a.mime.startsWith('video/')?'<video controls preload="metadata" src="'+escape(assetPath(a))+'"></video>':'<button data-read-text="'+escape(assetPath(a))+'">读取完整文本</button>')+'<code>SHA256 '+escape(a.sha256)+'</code></section>').join('')+'<details><summary>制作检查回执</summary><pre>'+escape(JSON.stringify(review.report,null,2))+'</pre></details>';
 for(const button of document.querySelectorAll('[data-read-text]'))button.onclick=async()=>{try{const response=await fetch(button.dataset.readText,{credentials:'same-origin'});if(!response.ok)throw Error('素材读取失败');const value=await response.text();if(!current()||!button.isConnected)return;const pre=document.createElement('pre');pre.textContent=value;button.replaceWith(pre);}catch(error){if(current())status(error.message,true);}};
 mountApproval(id,approval,{generation,workspace,account,current});$('#preview').showModal();}catch(error){if(current())status(error.message+'；素材状态未变更为可发布。',true);}}
async function showMetric(id){const current=beginPreview();try{const history=await api(evidencePath('metrics',id+'/history'));if(!current())return;$('#preview-title').textContent='指标观测历史';$('#preview-body').innerHTML='<h3>原始观测历史 · 最多 20 条</h3><p>来源、定义与窗口独立保留。不可用值为 null，不回退旧值。</p><pre>'+escape(JSON.stringify(history,null,2))+'</pre>';$('#preview').showModal();}catch(error){if(current())status(error.message,true);}}
$('#preview').addEventListener('close',()=>{if(!$('#preview').open)clearPreview();});

const checkLabels={CONTENT_FACTS:'正文事实已检查',VISUAL_QA:'图像与手机可读性已检查',VIDEO_PLAYBACK_AND_SUBTITLE_ALIGNMENT:'视频播放与字幕对齐已检查',ORIGINAL_SOURCE_REVIEW:'原始来源已人工查看'};
function mountApproval(id,approval,scope){
 const panel=document.createElement('section');panel.id='approval-controls';panel.innerHTML='<h3>内容审批回执</h3><p id="approval-state">'+escape(approval.state)+' · '+escape(approval.blocked_reason||'等待明确人工决定')+'</p><p>批准仅针对当前版本、媒体、账号和平台，不授予上传或发布权限。</p>'+(approval.can_decide?'<div class="checklist">'+approval.required_checks.map(k=>'<label><input type="checkbox" data-check="'+escape(k)+'">'+escape(checkLabels[k])+'</label>').join('')+'</div><label>审批或撤销理由<input id="approval-reason" maxlength="1000"></label><div><button data-decision="APPROVE">批准当前内容</button><button data-decision="REJECT" class="secondary">拒绝 / 撤销内容批准</button></div>':'')+'<details><summary>持久审批审计</summary><pre>'+escape(JSON.stringify(approval.history,null,2))+'</pre></details>';
 $('#preview-body').append(panel);const path=action=>'/api/sites/workspaces/'+scope.workspace+'/reviews/'+id+'/'+action+'?accountId='+encodeURIComponent(scope.account),current=()=>scope.current()&&panel.isConnected;
 for(const button of panel.querySelectorAll('[data-decision]'))button.onclick=async()=>{if(button.disabled)return;button.disabled=true;const input={command_id:button.dataset.command||(button.dataset.command=crypto.randomUUID()),decision:button.dataset.decision,expected_subject:approval.subject_fingerprint,expected_event_id:approval.latest_event_id,reason:panel.querySelector('#approval-reason').value.trim(),checks:Object.fromEntries([...panel.querySelectorAll('[data-check]')].map(x=>[x.dataset.check,x.checked])),confirmation:'CONTENT_ONLY'};try{const receipt=await api(path('approval'),input);if(current()){status('内容决定已持久保存；未授予发布许可。回执 '+receipt.event_id);await showReview(id);}}catch(error){if(current())status(error.message+'；请先回读审批记录。',true);}finally{if(button.isConnected)button.disabled=false;}};
 if(approval.can_decide&&approval.state==='CONTENT_APPROVED'&&approval.choices.length){const select=document.createElement('select');select.id='prepare-choice';select.innerHTML=approval.choices.map((c,i)=>'<option value="'+i+'">'+escape(platformNames[c.platform]+' · '+c.source_id+' / '+c.payload_artifact_id)+'</option>').join('');const button=document.createElement('button');button.id='prepare-plan';button.textContent='准备平台预览与草稿任务';panel.append(select,button);button.onclick=async()=>{button.disabled=true;const choice=approval.choices[Number(select.value)];try{const result=await api(path('prepare'),{source_id:choice.source_id,payload_artifact_id:choice.payload_artifact_id,expected_subject:approval.subject_fingerprint,expected_event_id:approval.latest_event_id});if(current()){const loading=loadScope(),generation=state.generation,epoch=previewEpoch;await loading;if(generation!==state.generation||epoch!==previewEpoch)return;const previewing=showPlan(result.id),planEpoch=previewEpoch;await previewing;if(generation===state.generation&&planEpoch===previewEpoch)status('已冻结明确平台稿和已审媒体；未上传或发布。');}}catch(error){if(current())status(error.message+'；先刷新核对准备回执。',true);}finally{if(button.isConnected)button.disabled=false;}};}
}
async function showPlan(id,sourceAccount=state.account){const current=beginPreview(),workspace=state.workspace,account=sourceAccount;try{const p=await api('/api/sites/workspaces/'+workspace+'/plans/'+id+'?accountId='+encodeURIComponent(account));if(!current())return;const assetPath=a=>'/api/sites/workspaces/'+workspace+'/reviews/'+p.review_id+'/assets/'+encodeURIComponent(a.source_id)+'/'+encodeURIComponent(a.artifact_id)+'?accountId='+encodeURIComponent(account);$('#preview-title').textContent='已审版本的平台准备预览';$('#preview-body').innerHTML='<p>来源审核账号：'+escape(state.accounts.find(a=>a.account_id===account)?.display_name||account)+'；审批不会转移给其他目标账号。</p><h3>'+escape(p.payload.title)+'</h3><p id="plan-state">'+escape(p.status)+' · '+escape(p.job_state)+' · '+escape(p.blocked_reason||'内容批准不等于发布许可')+'</p><p>'+escape(platformNames[p.platform])+' · '+escape(p.payload_source_sha256)+'</p><pre>'+escape(p.payload.body)+'</pre>'+p.media.map(a=>'<section class="review-asset">'+(a.mime.startsWith('video/')?'<video controls preload="metadata" src="'+escape(assetPath(a))+'"></video>':'<img alt="已审平台媒体" src="'+escape(assetPath(a))+'">')+'<code>SHA256 '+escape(a.sha256)+'</code></section>').join('')+'<p>真实上传和执行未启用。许可状态：'+escape(p.publication_authority.state)+'</p>';mountTargetReview(p,{workspace,account,current});$('#preview').showModal();}catch(error){if(current())status(error.message,true);}}

function mountTargetReview(plan,source){
 const target=state.accounts.find(a=>a.account_id===state.targetAccount&&a.platform===state.previewPlatform);
 if(!target||target.account_id===source.account||target.platform!==plan.platform)return;
 const panel=document.createElement('section');panel.id='target-review-controls';panel.innerHTML='<h3>新目标独立审核</h3><p>目标：'+escape(target.display_name)+' · '+escape(platformNames[target.platform])+' · '+escape(target.external_identity||'身份未核验')+'</p><p>复用当前已校验媒体，新建待审核记录；不会复制原账号批准，不会上传或发布。</p>';
 $('#preview-body').append(panel);
 if(!plan.can_request_target_review){const note=document.createElement('p');note.textContent='目标审核来源提供方或管理员尚未接入，或来源已失效。';panel.append(note);return;}
 const button=document.createElement('button');button.id='request-target-review';button.textContent='为此目标创建独立审核';panel.append(button);
 const key=JSON.stringify([source.workspace,plan.id,plan.source_subject,plan.source_event_id,target.account_id,target.platform]);
 const current=()=>source.current()&&state.workspace===source.workspace&&state.account===target.account_id&&state.targetAccount===target.account_id&&state.previewPlatform===target.platform;
 button.onclick=async()=>{
  if(button.disabled||!current())return;button.disabled=true;
  if(!targetReviewCommands.has(key))targetReviewCommands.set(key,crypto.randomUUID());
  try{
   const result=await api('/api/sites/workspaces/'+source.workspace+'/plans/'+plan.id+'/retarget?accountId='+encodeURIComponent(target.account_id),{command_id:targetReviewCommands.get(key),expected_subject:plan.source_subject,expected_event_id:plan.source_event_id,expected_platform:target.platform});
   if(!current())return;const loading=loadScope(),generation=state.generation,epoch=previewEpoch;await loading;if(generation!==state.generation||epoch!==previewEpoch)return;
   tab('review');const previewing=showReview(result.id),reviewEpoch=previewEpoch;await previewing;if(generation===state.generation&&reviewEpoch===previewEpoch)status('新目标审核已入账；请独立检查并作出内容决定。');
  }catch(error){if(current())status(error.message+'；请先回读审核列表，原命令保留，不自动重试。',true);}finally{if(button.isConnected)button.disabled=false;}
 };
}


function variantPath(workspace,id,viewer){return '/api/sites/workspaces/'+workspace+'/contents/'+id+'/variants?accountId='+encodeURIComponent(viewer);}
function stashVariant(){const d=variantDrafts.get(variantKey);if(d&&!d.pending&&!d.command)d.values={title:$('#variant-title').value,body:$('#variant-body').value};}
function detachVariant(){stashVariant();variantContext=null;variantKey=null;++variantEpoch;$('#variant-form').hidden=true;}
function variantCurrent(key,epoch){return key===variantKey&&epoch===variantEpoch&&variantContext?.workspace===state.workspace&&variantContext?.viewer===state.account&&!$('#variant-form').hidden;}
function paintVariant(){
 const d=variantDrafts.get(variantKey);if(!d)return;const c=d.base.content,p=d.platform;$('#variant-form').hidden=false;$('#variant-platform').value=p;$('#variant-title').value=d.values.title;$('#variant-body').value=d.values.body;
 $('#variant-source').textContent='来源账号：'+(state.accounts.find(a=>a.account_id===c.account_id)?.display_name||c.account_id)+' · '+c.content_id+' / '+c.slug+' · 基础版本 '+c.revision+' · '+platformNames[p];
 $('#variant-status').textContent=d.message||(d.base.requires_new_inspection?'保留原媒体绑定；文字变更将撤销相关批准，编辑稿必须重新校验与审核。':d.base.content.variants[p]?'独立编辑此平台；其他平台不会被覆盖。':'此平台尚无明确稿件，请填写；不会借用其他平台正文。');
 for(const el of [$('#variant-title'),$('#variant-body')])el.readOnly=Boolean(d.pending||d.command||d.rebasing);
 $('#variant-save').disabled=Boolean(d.pending||d.rebasing);$('#variant-save').textContent=d.command?'使用原命令核对保存结果':'保存此平台新版本';$('#variant-rebase').disabled=Boolean(d.pending||d.command||d.rebasing);
}
function selectVariant(platform){
 if(!variantContext)return;const key=JSON.stringify([variantContext.workspace,variantContext.viewer,variantContext.base.source.root_content_id,platform]);
 if(!variantDrafts.has(key)){const v=variantContext.base.content.variants[platform];variantDrafts.set(key,{base:variantContext.base,platform,values:{title:v?.title||'',body:v?.body||''},command:null,submitted:null,pending:false,message:''});}
 variantKey=key;++variantEpoch;paintVariant();
}
async function openVariant(id,platform){
 detachVariant();const epoch=++variantEpoch,workspace=state.workspace,viewer=state.account;if(!viewer)return;
 try{const base=await api(variantPath(workspace,id,viewer));if(epoch!==variantEpoch||workspace!==state.workspace||viewer!==state.account)return;variantContext={workspace,viewer,base};selectVariant(platform);$('#variant-form').scrollIntoView({behavior:'smooth'});}catch(error){if(epoch===variantEpoch)status(error.message,true);}
}
async function rebaseVariant(){
 stashVariant();const key=variantKey,epoch=variantEpoch,d=variantDrafts.get(key),context=variantContext;if(!d||d.pending||d.command||d.rebasing)return;
 const base=d.base;d.rebasing=true;paintVariant();
 try{const current=await api(variantPath(context.workspace,base.content.id,context.viewer)),latest=current.latest.id===base.content.id?current:await api(variantPath(context.workspace,current.latest.id,context.viewer));
  if(!variantCurrent(key,epoch)||d.pending||d.command||d.base!==base)return;if(latest.source.root_content_id!==base.source.root_content_id)throw Error('来源版本已改变，请从新来源重新打开编辑');d.base=latest;variantContext.base=latest;d.message='已读取最新基础版本，保留当前平台的未保存文字。请核对再保存。';
 }catch(error){if(variantCurrent(key,epoch))d.message=error.message;}
 finally{d.rebasing=false;if(key===variantKey&&variantContext?.workspace===state.workspace&&variantContext?.viewer===state.account)paintVariant();}
}
async function saveVariant(event){
 event.preventDefault();stashVariant();const key=variantKey,epoch=variantEpoch,d=variantDrafts.get(key),context=variantContext;if(!d||d.pending||d.rebasing)return;
 if(!d.command){d.command=crypto.randomUUID();d.submittedBaseId=d.base.content.id;d.submitted={command_id:d.command,expected_payload_hash:d.base.content.payload_hash,expected_source_binding:d.base.source_binding_hash,platform:d.platform,title:d.values.title.trim(),body:d.values.body.trim()};}
 d.pending=true;paintVariant();
 try{const r=await api(variantPath(context.workspace,d.submittedBaseId,context.viewer),d.submitted);d.message='已保存独立平台版本 '+r.revision+'；未上传或发布。';
  // A committed receipt is enough to unlock the old command. Fetch the new base
  // before allowing a further edit; if readback fails retain the exact command.
  const base=await api(variantPath(context.workspace,r.id,context.viewer));d.base=base;d.values={title:base.content.variants[d.platform].title,body:base.content.variants[d.platform].body};d.command=null;d.submitted=null;d.submittedBaseId=null;
  if(variantCurrent(key,epoch)){variantContext.base=base;const loading=loadScope(),generation=state.generation;await loading;if(generation===state.generation&&variantCurrent(key,epoch))paintVariant();}
 }catch(error){
  if(['VARIANT_VERSION_CONFLICT','VARIANT_CONCURRENT_CHANGE','VARIANT_INPUT_INVALID','VARIANT_UNCHANGED','VARIANT_REVIEW_PLATFORM_REQUIRED'].includes(error.message)){d.command=null;d.submitted=null;d.submittedBaseId=null;}
  d.message=error.message+(d.command?'；结果待核对，保留原命令，不自动重试。':'；草稿保留，可读取最新基础后再保存。');
 }finally{d.pending=false;if(key===variantKey&&variantContext?.workspace===context.workspace&&variantContext?.viewer===context.viewer&&!$('#variant-form').hidden){variantContext.base=d.base;paintVariant();}}
}
function previewVariant(view,payload){
 preview(payload,view.content.body,view.content.payload_hash);if(!view.source.source_plan_id)return;
 const section=document.createElement('section');section.innerHTML='<p>原版本媒体仅供核对；当前编辑稿尚未通过新检查与审核。</p>'+view.source.media.map(a=>{const path='/api/sites/workspaces/'+view.content.workspace+'/reviews/'+view.source.source_review_id+'/assets/'+encodeURIComponent(a.source_id)+'/'+encodeURIComponent(a.artifact_id)+'?accountId='+encodeURIComponent(view.content.account_id);return '<section class="review-asset">'+(a.mime.startsWith('video/')?'<video controls preload="metadata" src="'+escape(path)+'"></video>':'<img alt="原版本媒体，编辑稿待重新审核" src="'+escape(path)+'">')+'<code>SHA256 '+escape(a.sha256)+'</code></section>';}).join('');$('#preview-body').append(section);
}
async function showEditedContent(id){const current=beginPreview(),workspace=state.workspace,viewer=state.account,platform=state.previewPlatform;try{const v=await api(variantPath(workspace,id,viewer));if(!current())return;previewVariant(v,v.content.variants[platform]);}catch(error){if(current())status(error.message,true);}}
