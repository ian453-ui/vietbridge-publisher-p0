import {productionBinding,assertProductionDraft,assertProductionJobCurrent,assertProductionExecution,assertNoProductionMediaClone,handoffHash} from './production-handoff-guard.js';
import {libraryPlatformEligibility} from './platform-copy-provenance.js';
import {publicationReference,assertPublicationReference,publicationMedia} from './browser-skill-publication.js';
import {matchesRetainedFacebookPublication} from './facebook-preparation-duplicate.js';
import {createHash, randomUUID} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {InteractionBudget} from './interaction-budget.js';
import {publishingPlatforms,platformOf,guardedStates,retainsPreparationEffects,publicOptions,validatePlatformPayload} from './publisher-platforms.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const required = (value, label) => typeof value === 'string' && value.trim() ? value.trim() : fail(`${label}不能为空`);

/** One account/content registry for publishing and interaction; never opens a V1 DB. */
export class UnifiedPublisher {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    store.interactionBudget=new InteractionBudget(store);
    if(!this.db.prepare('PRAGMA table_info(facebook_accounts)').all().some(c=>c.name==='publisher_transport'))this.db.exec("ALTER TABLE facebook_accounts ADD COLUMN publisher_transport TEXT NOT NULL DEFAULT 'BROWSER'");
    const columns=this.db.prepare('PRAGMA table_info(facebook_accounts)').all();
    if(!columns.some(c=>c.name==='platform'))this.db.exec("ALTER TABLE facebook_accounts ADD COLUMN platform TEXT NOT NULL DEFAULT 'facebook'; ALTER TABLE facebook_accounts ADD COLUMN publisher_options_json TEXT NOT NULL DEFAULT '{}'");
    if(!columns.some(c=>c.name==='operator_actor_id'))this.db.exec("ALTER TABLE facebook_accounts ADD COLUMN operator_actor_id TEXT; ALTER TABLE facebook_accounts ADD COLUMN target_page_id TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publisher_content_sources (
        workspace TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
        content_id TEXT NOT NULL REFERENCES group_content(id), payload_hash TEXT NOT NULL,
        PRIMARY KEY(workspace,source_id,revision)
      );
      CREATE TABLE IF NOT EXISTS publisher_content_variants(content_id TEXT NOT NULL,platform TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(content_id,platform));
      CREATE TABLE IF NOT EXISTS publisher_jobs (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES facebook_accounts(id),
        content_id TEXT NOT NULL REFERENCES group_content(id),
        snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('DRAFT','READY','PREPARING','SUBMITTING','PUBLISHED','DRAFT_WRITTEN','PUBLISHED_ID_PENDING','CANCELLED','BLOCKED','UNKNOWN')),
        attempt_id TEXT, evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace,account_id,content_id,snapshot_hash)
      );
      CREATE INDEX IF NOT EXISTS publisher_jobs_scope ON publisher_jobs(workspace,account_id,created_at);
      CREATE TABLE IF NOT EXISTS publisher_browser_locks (
        profile_id TEXT PRIMARY KEY REFERENCES execution_profiles(id),
        job_id TEXT NOT NULL UNIQUE REFERENCES publisher_jobs(id), token TEXT NOT NULL
      );
    `);
    // Recovery is an explicit startup operation, not a constructor side effect.
    // A second reader must never turn a live executor's task into UNKNOWN.
  }

  saveAccount(workspace, input) {
    if(input.platform&&input.platform!=='facebook')return this.savePlatformAccount(workspace,input);
    const current=input.id?this.account(workspace,input.id,{includeDisabled:true}):null;
    if(current&&current.platform!=='facebook')fail('不能把其他平台账号改成 Facebook');
    const transport=input.publisher_transport||current?.publisher_transport||'BROWSER';
    if(!['API','BROWSER'].includes(transport))fail('发布方式必须为 API 或 BROWSER');
    if(!['PAGE','PROFILE'].includes(input.identity_type))fail('请选择 Page 或个人操作身份');
    if(!/^\d+$/.test(String(input.external_id || '')))fail('请填写已核实的 Facebook 身份 ID');
    const operatorActorId=String(input.operator_actor_id||current?.operator_actor_id||input.external_id||'');
    const targetPageId=String(input.target_page_id||current?.target_page_id||'');
    if(operatorActorId!==String(input.external_id)||!/^\d+$/.test(operatorActorId))fail('操作 actor 必须与账号的浏览器身份一致');
    if(input.identity_type==='PAGE'&&!/^\d+$/.test(targetPageId))fail('请独立填写已核实的 Business 目标 Page ID');
    let configUrl=input.config_url;
    if(transport==='API') {
      configUrl=configUrl|| (input.id?this.store.account(workspace,input.id).config_url:null);
      configUrl=this.credentialReference(configUrl);
    }
    if(this.db.prepare("SELECT 1 FROM facebook_accounts WHERE profile_id=? AND platform='wechat_channels'").get(input.profile_id))fail('不能用视频号原环境登记Facebook身份');
    const account=this.store.saveAccount(workspace, {...input, config_url:configUrl, execution_transport:'BROWSER'});
    this.db.prepare('UPDATE facebook_accounts SET publisher_transport=?,operator_actor_id=?,target_page_id=? WHERE id=? AND workspace=?').run(transport,operatorActorId,targetPageId||null,account.id,workspace);
    return this.account(workspace,account.id,{includeDisabled:true});
  }

  // A single physical registry retains its historical name for existing FK references.
  account(workspace,id,{includeDisabled=false}={}){
    this.store.requireWorkspace(workspace);
    const row=this.db.prepare('SELECT * FROM facebook_accounts WHERE id=? AND workspace=?').get(id,workspace);
    if(!row||!row.enabled&&!includeDisabled)fail('操作账号不属于当前客户或已停用');
    return {...row,publisher_options:JSON.parse(row.publisher_options_json)};
  }
  accountsView(workspace){
    this.store.requireWorkspace(workspace);
    const publisherAccounts=this.db.prepare('SELECT * FROM facebook_accounts WHERE workspace=? ORDER BY rowid DESC').all(workspace).map(x=>({...x,publisher_options:JSON.parse(x.publisher_options_json)}));
    const saved=this.db.prepare("SELECT value FROM workspace_preferences WHERE workspace=? AND key='selected_publisher_account'").get(workspace)?.value;
    return {publisherAccounts,selectedPublisherAccountId:publisherAccounts.find(x=>x.id===saved&&x.enabled)?.id||publisherAccounts.find(x=>x.enabled)?.id||null};
  }
  contentStatus(workspace,id){
    const account=this.account(workspace,id);
    const rows=account.platform==='facebook'
      ?this.db.prepare("SELECT content_id,state FROM publisher_jobs WHERE workspace=? AND coalesce(json_extract(snapshot_json,'$.platform'),'facebook')='facebook' AND (json_extract(snapshot_json,'$.targetPageId')=? OR json_extract(snapshot_json,'$.targetPageId') IS NULL AND json_extract(snapshot_json,'$.externalId') IN (?,?))").all(workspace,account.target_page_id,account.external_id,account.target_page_id)
      :this.db.prepare("SELECT content_id,state FROM publisher_jobs WHERE workspace=? AND json_extract(snapshot_json,'$.platform')=? AND json_extract(snapshot_json,'$.externalId')=?").all(workspace,account.platform,account.external_id);
    const states={};for(const row of rows)(states[row.content_id]||=[]).push(row.state);
    return {states};
  }
  selectAccount(workspace,id){const account=this.account(workspace,id);this.db.prepare("INSERT INTO workspace_preferences VALUES(?,'selected_publisher_account',?,?) ON CONFLICT(workspace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(workspace,id,new Date().toISOString());return account;}
  savePlatformAccount(workspace,input){
    this.store.requireWorkspace(workspace);
    const platform=input.platform,cap=publishingPlatforms[platform];if(!cap||platform==='facebook')fail('平台无效');
    const current=input.id?this.account(workspace,input.id,{includeDisabled:true}):null;
    if(current&&current.platform!==platform)fail('不能把现有账号改成另一个平台');
    const id=current?.id||randomUUID(),name=required(input.display_name,'账号名称'),externalId=required(input.external_id,'实际平台身份'),profileId=platform==='xiaohongshu'?(input.profile_id??current?.profile_id??''):required(input.profile_id,'专用执行环境');
    if(typeof profileId!=='string')fail('执行环境标识格式无效');
    if(profileId&&!this.db.prepare('SELECT 1 FROM execution_profiles WHERE id=? AND workspace=?').get(profileId,workspace))fail('执行环境不属于当前客户');
    if(platform!=='xiaohongshu'&&!profileId)fail('专用执行环境不能为空');
    if(platform==='xiaohongshu'&&!/^username:.+/.test(externalId))fail('小红书身份应为只读核实的 username:名称');
    if(platform==='wechat_official_account'&&!/^wx[a-f0-9]{16}$/i.test(externalId))fail('公众号身份需要已核实的 App ID');
    const options=publicOptions(platform,input.publisher_options||current?.publisher_options||{});
    if(platform==='xiaohongshu')for(const other of this.db.prepare("SELECT id,workspace,publisher_options_json FROM facebook_accounts WHERE platform='xiaohongshu' AND id<>?").all(id)){if(other.workspace===workspace)continue;const endpoint=publicOptions('xiaohongshu',JSON.parse(other.publisher_options_json)).mcp_endpoint;if(endpoint===options.mcp_endpoint)fail('该MCP连接已登记到另一客户，不能借用其会话');}
    if(platform==='wechat_channels'&&this.db.prepare("SELECT 1 FROM facebook_accounts WHERE profile_id=? AND id<>?").get(profileId,id))fail('视频号原环境不能借用其他账号的环境');
    if(this.db.prepare('SELECT 1 FROM facebook_accounts WHERE platform=? AND external_id=? AND id<>?').get(platform,externalId,id))fail('该平台身份已有账号记录；不能复制成另一个客户账号');
    const config=platform==='wechat_official_account'?this.credentialReference(input.config_url||current?.config_url):null;
    this.db.prepare(`INSERT INTO facebook_accounts(id,workspace,display_name,identity_type,external_id,profile_id,expected_identity,session_health,enabled,config_url,execution_transport,publisher_transport,platform,publisher_options_json)
      VALUES(?,?,?,?,?,?,?,'UNKNOWN',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,external_id=excluded.external_id,profile_id=excluded.profile_id,expected_identity=excluded.expected_identity,enabled=excluded.enabled,config_url=excluded.config_url,publisher_options_json=excluded.publisher_options_json`)
      .run(id,workspace,name,'PLATFORM',externalId,profileId,String(input.expected_identity||name).trim(),input.enabled===false?0:1,config,platform==='wechat_channels'?'BROWSER':null,cap.transports[0],platform,JSON.stringify(options));
    return this.account(workspace,id,{includeDisabled:true});
  }

  credentialReference(value) {
    if(!value)fail('API 模式需要现有的本机授权配置文件');
    let path=String(value);if(path.startsWith('file://'))path=fileURLToPath(path);
    if(!isAbsolute(path))fail('API 授权配置必须是本机绝对路径');
    const real=realpathSync(path),info=statSync(real);
    if(!info.isFile()||(info.mode&0o077)!==0)fail('API 授权配置必须是权限为 600 或更严格的本机文件');
    return real;
  }

  switchTransport(workspace,accountId,transport,configUrl) {
    const account=this.store.account(workspace,accountId);
    if(!['API','BROWSER'].includes(transport))fail('发布方式必须为 API 或 BROWSER');
    return this.saveAccount(workspace,{...account,enabled:Boolean(account.enabled),publisher_transport:transport,config_url:configUrl||account.config_url});
  }

  importContent(workspace, input, {productionPlanId}={}) {
    this.store.requireWorkspace(workspace);
    if(productionPlanId){const row=this.db.prepare('SELECT * FROM production_upload_plans WHERE id=? AND workspace=?').get(productionPlanId,workspace);if(!row||handoffHash(row.manifest_json)!==row.manifest_hash)fail('PRODUCTION_PLAN_SCOPE_DENIED');const m=JSON.parse(row.manifest_json),expected={source_id:'production-review:'+productionPlanId,revision:'1',title:m.payload.title,body:m.payload.body,media:m.media.map(a=>a.path),platform_payloads:{[m.platform]:{...m.payload,media:m.media.map(a=>a.path)}}};if(handoffHash(input)!==handoffHash(expected))fail('PRODUCTION_APPROVED_PAYLOAD_CHANGED');}
    else{if(String(input.source_id||'').startsWith('production-review:'))fail('PRODUCTION_PLAN_REQUIRED');assertNoProductionMediaClone(this.db,[...(input.media||[]),...Object.values(input.platform_payloads||{}).flatMap(p=>p.media||[])]);}
    const sourceId=required(input.source_id,'云端内容编号'), revision=required(input.revision,'云端版本');
    const body=required(input.body,'正文'), title=String(input.title || '').trim();
    if(!Array.isArray(input.media) || input.media.some(x => typeof x !== 'string' || !x.trim()))fail('媒体引用格式无效');
    const variants=input.platform_payloads||{};
    if(!variants||typeof variants!=='object'||Array.isArray(variants)||Object.keys(variants).some(k=>!publishingPlatforms[k]))fail('平台文案格式无效');
    for(const [platform,payload] of Object.entries(variants)){
      if(!payload||Object.keys(payload).some(k=>!['title','body','tags','author','media'].includes(k))||typeof payload.body!=='string'||!Array.isArray(payload.media)||payload.media.some(x=>typeof x!=='string'))fail('平台文案或媒体格式无效');
      validatePlatformPayload(platform,{title:String(payload.title||title),body:payload.body,tags:payload.tags||[]},payload.media);
    }
    const media=input.media.map(x=>x.trim()), payloadHash=digest({title,body,media,variants});
    return this.store.tx(()=>{
      const old=this.db.prepare('SELECT * FROM publisher_content_sources WHERE workspace=? AND source_id=? AND revision=?').get(workspace,sourceId,revision);
      if(old){
        if(old.payload_hash!==payloadHash)fail('同一云端版本的内容发生变化，请使用新版本');
        return this.db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(old.content_id,workspace);
      }
      const content=this.store.createContent(workspace,{title,body,media},{productionPlanId});
      for(const [platform,payload] of Object.entries(variants))this.db.prepare('INSERT INTO publisher_content_variants VALUES(?,?,?)').run(content.id,platform,JSON.stringify(payload));
      this.db.prepare('INSERT INTO publisher_content_sources VALUES(?,?,?,?,?)').run(workspace,sourceId,revision,content.id,payloadHash);
      return content;
    });
  }
  platformEligibility(id,platform){const plan=productionBinding(this.db,id);if(plan&&plan.manifest.platform!==platform)return {allowed:false,blockedReason:'制作审核仅冻结了该账号对应的平台稿，不能沿用到其他平台'};return libraryPlatformEligibility(this.db,id,platform);}
  assertPlatformSource(id,platform){const result=this.platformEligibility(id,platform);if(!result.allowed)fail(result.blockedReason);}
  contentVariants(id){return Object.fromEntries(this.db.prepare('SELECT platform,payload_json FROM publisher_content_variants WHERE content_id=?').all(id).map(x=>[x.platform,JSON.parse(x.payload_json)]));}

  context(workspace, accountId) {
    this.store.requireWorkspace(workspace);
    const account=this.account(workspace,accountId);
    const profile=account.profile_id?this.db.prepare('SELECT * FROM execution_profiles WHERE id=? AND workspace=?').get(account.profile_id,workspace):null;
    const connectorOnly=account.platform==='xiaohongshu'&&account.publisher_transport==='MCP'&&!account.profile_id;
    if(!profile&&!connectorOnly)fail('账号浏览器环境不存在');
    if(connectorOnly)publicOptions('xiaohongshu',account.publisher_options);
    if(!publishingPlatforms[account.platform]?.transports.includes(account.publisher_transport))fail('该账号尚未配置发布方式');
    if(account.platform==='facebook'&&!/^\d+$/.test(String(account.external_id || '')))fail('账号身份 ID 未核实');
    return {account,profile};
  }

  createPageJob(workspace, input) {
    const {account,profile}=this.context(workspace,input.account_id);
    const platform=account.platform;
    if(platform==='facebook'&&account.identity_type!=='PAGE')fail('Page 发布需要选择企业 Page 身份');
    const content=this.db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(input.content_id,workspace);
    if(!content)fail('内容不属于当前客户');
    const variant=this.contentVariants(content.id)[platform],overrides=input.payload||{};
    if(variant?.blockedReason)fail(variant.blockedReason);
    if(!variant&&(platform!=='facebook'||Object.keys(this.contentVariants(content.id)).length>0)&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='group_library_imports'").get()&&this.db.prepare('SELECT 1 FROM group_library_imports WHERE content_id=? AND workspace=?').get(content.id,workspace))fail('此稿尚无该平台公开文案，不能沿用其他平台正文创建任务');
    this.assertPlatformSource(content.id,platform);
    if(Object.keys(overrides).some(k=>!['title','body','tags','author'].includes(k)))fail('任务文案字段无效');
    const payload={title:String(overrides.title??variant?.title??content.title).trim(),body:String(overrides.body??variant?.body??content.body).trim(),tags:overrides.tags||variant?.tags||[],author:String(overrides.author||variant?.author||'驻越经营实录').trim()};
    if(!Array.isArray(payload.tags)||payload.tags.some(x=>typeof x!=='string'||!x.trim()||/[#\n\r]/.test(x)))fail('话题字段格式无效');
    payload.tags=[...new Set(payload.tags.map(x=>x.trim()))];
    const sourceMedia=JSON.parse(content.media_json),media=variant?.media||sourceMedia;validatePlatformPayload(platform,payload,media);
    if(platform==='facebook'&&(!account.operator_actor_id||!account.target_page_id))fail('请核实操作 actor 和目标 Page，不能从旧单一身份自动推断');
    const snapshot={workspace,operatorActorId:platform==='facebook'?account.operator_actor_id:null,targetPageId:platform==='facebook'?account.target_page_id:null,accountId:account.id,externalId:account.external_id,identityType:account.identity_type,
      expectedIdentity:account.expected_identity,profileId:profile?.id??null,profileDir:profile?.user_data_dir??null,cdpPort:profile?.cdp_port??null,...(!profile?{executionRef:{kind:'MCP',endpoint:account.publisher_options.mcp_endpoint}}:{}),
      contentId:content.id,title:payload.title,body:payload.body,sourceTitle:content.title,sourceBody:content.body,sourceMedia,variantHash:digest(variant||null),media,contentHash:content.content_hash,payloadHash:digest({platform,payload,media}),payload,platform,options:account.publisher_options,
      operation:platform==='facebook'?'FACEBOOK_PAGE_PUBLISH':platform==='wechat_official_account'?'WECHAT_DRAFT_CREATE':platform==='wechat_channels'?'WECHAT_CHANNELS_PUBLISH':'XIAOHONGSHU_PUBLISH',transport:account.publisher_transport,
      credentialRef:account.publisher_transport==='API'?this.credentialReference(account.config_url):null};
    if(platform==='facebook'&&this.browserSkill?.matches(workspace,account.id)){
      Object.assign(snapshot,publicationReference(this.browserSkill,account));
      snapshot.assetMetadata=publicationMedia(media);
    }
    const productionReview=assertProductionDraft(this.db,content.id,{workspace,accountId:account.id,platform,payload,media});if(productionReview)snapshot.productionReview=productionReview;
    const fingerprint=digest(snapshot), time=new Date().toISOString();
    return this.store.tx(()=>{
      const prior=this.db.prepare(`SELECT snapshot_json,state FROM publisher_jobs WHERE workspace=? AND account_id=? AND state IN ('PREPARING','SUBMITTING','UNKNOWN','PUBLISHED')`).all(workspace,account.id);
      const all=this.db.prepare('SELECT id,snapshot_json,evidence_json,state FROM publisher_jobs WHERE workspace=?').all(workspace);
      if(all.some(row=>matchesRetainedFacebookPublication(this.db,row,snapshot)))fail('相同实际正文与媒体仍有准备副作用待核对，不能重发');
      if(all.some(row=>{const s=JSON.parse(row.snapshot_json);return (guardedStates.includes(row.state)||retainsPreparationEffects(row))&&platformOf(s)===platform&&(platform==='facebook'?(s.targetPageId||s.externalId):s.externalId)===(snapshot.targetPageId||snapshot.externalId)&&(s.payloadHash||s.contentHash)===(snapshot.payloadHash||snapshot.contentHash);}))fail('相同目标和内容已有已提交或待核对任务，请先核对历史');
      this.db.prepare(`INSERT OR IGNORE INTO publisher_jobs(id,workspace,account_id,content_id,snapshot_json,snapshot_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'DRAFT',?,?)`)
        .run(randomUUID(),workspace,account.id,content.id,JSON.stringify(snapshot),fingerprint,time,time);
      return this.decode(this.db.prepare('SELECT * FROM publisher_jobs WHERE workspace=? AND account_id=? AND content_id=? AND snapshot_hash=?').get(workspace,account.id,content.id,fingerprint));
    });
  }

  decode(row) { return {...row,snapshot:JSON.parse(row.snapshot_json),evidence:JSON.parse(row.evidence_json)}; }
  job(workspace, id) {
    this.store.requireWorkspace(workspace);
    return this.decode(this.db.prepare('SELECT * FROM publisher_jobs WHERE id=? AND workspace=?').get(id,workspace) || fail('任务不属于当前客户或不存在'));
  }
  list(workspace, accountId, {limit=100,offset=0}={}) {
    this.store.requireWorkspace(workspace);
    if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)fail('分页参数无效');
    if(accountId)this.account(workspace,accountId);
    const rows=accountId
      ? this.db.prepare('SELECT * FROM publisher_jobs WHERE workspace=? AND account_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(workspace,accountId,limit,offset)
      : this.db.prepare('SELECT * FROM publisher_jobs WHERE workspace=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(workspace,limit,offset);
    return rows.map(row=>this.decode(row));
  }
  approve(workspace,id,fingerprint,{simulationFactory}={}) {
    return this.store.tx(()=>{
      const job=this.job(workspace,id);
      assertProductionExecution(this.db,job,simulationFactory);
      if(job.snapshot_hash!==fingerprint || digest(job.snapshot)!==fingerprint)fail('任务预览已失效');
      this.assertCurrent(job);
      if(job.state!=='DRAFT')fail('只能批准待确认任务');
      this.db.prepare("UPDATE publisher_jobs SET state='READY',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
      return this.job(workspace,id);
    });
  }
  assertCurrent(job) {
    assertProductionJobCurrent(this.db,job);
    if(job.evidence?.operatorFinished)fail('任务已结束处理，不可再次发布');
    const {account,profile}=this.context(job.workspace,job.account_id),s=job.snapshot;
    if(platformOf(s)!==account.platform||digest(s.options||{})!==digest(account.publisher_options||{}))fail('平台或账号配置已变化，请重新创建任务');
    if(account.platform==='facebook'&&(!s.operatorActorId||!s.targetPageId||s.operatorActorId!==account.operator_actor_id||s.targetPageId!==account.target_page_id))fail('操作 actor 或目标 Page 未冻结或已变化，请重新创建任务');
    const variants=this.contentVariants(job.content_id),variant=variants[account.platform];
    if(variant?.blockedReason)fail(variant.blockedReason);
    if(!variant&&(account.platform!=='facebook'||Object.keys(variants).length>0)&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='group_library_imports'").get()&&this.db.prepare('SELECT 1 FROM group_library_imports WHERE content_id=? AND workspace=?').get(job.content_id,job.workspace))fail('此稿尚无该平台公开文案，不能执行');
    this.assertPlatformSource(job.content_id,account.platform);
    if(s.variantHash&&s.variantHash!==digest(this.contentVariants(job.content_id)[account.platform]||null))fail('平台文案版本已变化，请重新创建任务');
    if(account.identity_type!==s.identityType || account.external_id!==s.externalId || account.expected_identity!==s.expectedIdentity)fail('账号或浏览器环境已变化，请重新创建任务');
    if(s.transport==='BROWSER_SKILL'){
      assertPublicationReference(s,this.browserSkill,account);
      if(JSON.stringify(s.assetMetadata)!==JSON.stringify(publicationMedia(s.media)))fail('BSK_FROZEN_MEDIA_CHANGED');
    }else{
      if((profile?.id??null)!==s.profileId||(profile?.user_data_dir??null)!==s.profileDir||(profile?.cdp_port??null)!==s.cdpPort)fail('账号或浏览器环境已变化，请重新创建任务');
      if(!profile&&(!s.executionRef||s.executionRef.kind!=='MCP'||s.executionRef.endpoint!==account.publisher_options.mcp_endpoint))fail('原MCP连接未冻结或已改变');
    }
    const content=this.db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(job.content_id,job.workspace);
    if(!content || content.content_hash!==s.contentHash || content.title!==(s.sourceTitle??s.title) || content.body!==(s.sourceBody??s.body) || digest(JSON.parse(content.media_json))!==digest(s.sourceMedia||s.media))fail('内容版本已变化，请重新创建任务');
    if(digest(s)!==job.snapshot_hash)fail('任务快照已损坏');
    if(s.transport==='API' && this.credentialReference(s.credentialRef)!==s.credentialRef)fail('任务 API 授权配置路径已变化');
    if(s.transport==='API'&&account.config_url!==s.credentialRef)fail('账号授权配置引用已变化，请重新创建任务');
  }
  finish(workspace,id) {
    return this.store.tx(()=>{
      const job=this.job(workspace,id);
      if(['PREPARING','SUBMITTING'].includes(job.state))fail('任务正在执行，不能强行结束；请等待提交结果后核对');
      const hasSubmitTables=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publisher_submit_intents'").get()&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publisher_submit_receipts'").get());
      const noFinalSubmit=hasSubmitTables&&job.state==='UNKNOWN'&&job.evidence.stage==='PREPARING'&&job.evidence.submissionIntent===false&&job.evidence.browserDiagnostics?.finalClickAttempted===false&&
        !this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(id)&&!this.db.prepare('SELECT 1 FROM publisher_submit_receipts WHERE job_id=?').get(id);
      const evidence={...job.evidence,operatorFinished:true,operatorFinishedAt:new Date().toISOString(),...(noFinalSubmit?{preSubmissionVerified:true}:{})};
      const state=['DRAFT','READY','BLOCKED'].includes(job.state)?'CANCELLED':job.state;
      this.db.prepare('UPDATE publisher_jobs SET state=?,evidence_json=?,updated_at=? WHERE id=?').run(state,JSON.stringify(evidence),evidence.operatorFinishedAt,id);
      this.store.event(workspace,'publisher_task_finished',{job_id:id,previous_state:job.state,state});
      return this.job(workspace,id);
    });
  }
  manualComplete(workspace,id,input={}) {
    assertProductionExecution(this.db,this.job(workspace,id),null);
    return this.store.tx(()=>{
      const job=this.job(workspace,id);
      if(!['DRAFT','READY','BLOCKED','UNKNOWN'].includes(job.state))fail('当前状态不能人工确认完成');
      if(input.acknowledge!==true||input.snapshot_hash!==job.snapshot_hash||digest(job.snapshot)!==job.snapshot_hash)fail('请明确确认当前冻结任务和目标账号');
      let platformId=String(input.platform_id||'').trim();const url=String(input.url||'').trim();
      if(!platformId&&!url)fail('请提供平台作品链接或作品 ID');
      if(platformId&&!/^[A-Za-z0-9_-]{1,160}$/.test(platformId))fail('平台作品 ID 格式无效');
      if(url){
        let parsed;try{parsed=new URL(url);}catch{fail('作品链接格式无效');}
        const domains={facebook:['facebook.com'],xiaohongshu:['xiaohongshu.com','xhslink.com'],wechat_official_account:['mp.weixin.qq.com'],wechat_channels:['weixin.qq.com']};
        if(parsed.protocol!=='https:'||parsed.username||parsed.password||!(domains[platformOf(job.snapshot)]||[]).some(d=>parsed.hostname===d||parsed.hostname.endsWith('.'+d)))fail('作品链接与任务平台不符');
        if(url.length>2048||[...parsed.searchParams.keys()].some(k=>/token|secret|password|cookie/i.test(k)))fail('作品链接不能包含凭据或私密令牌');
        if(!platformId&&platformOf(job.snapshot)==='facebook')platformId=parsed.pathname.match(/\/posts\/([A-Za-z0-9_-]+)/)?.[1]||parsed.searchParams.get('story_fbid')||'';
        if(!platformId&&platformOf(job.snapshot)==='xiaohongshu')platformId=parsed.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)/)?.[1]||'';
        if(platformId&&!/^[A-Za-z0-9_-]{1,160}$/.test(platformId))fail('平台作品 ID 格式无效');
      }
      const time=new Date().toISOString(),evidence={...job.evidence,humanConfirmation:{at:time,previousState:job.state,platformId,url,snapshotHash:job.snapshot_hash,accountId:job.account_id},verified:false};
      this.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',evidence_json=?,updated_at=? WHERE id=?").run(JSON.stringify(evidence),time,id);
      this.store.event(workspace,'publisher_completion_human_confirmed',{job_id:id,snapshot_hash:job.snapshot_hash,platform_id:platformId,url,previous_state:job.state});
      return this.job(workspace,id);
    });
  }
  cancel(workspace,id) {
    return this.store.tx(()=>{
      const job=this.job(workspace,id);
      if(!['DRAFT','READY','BLOCKED'].includes(job.state))fail('执行中或结果未知的任务不能直接取消');
      this.db.prepare("UPDATE publisher_jobs SET state='CANCELLED',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
      return this.job(workspace,id);
    });
  }
  recoverAfterShutdown() {
    // Call only after the previous process is confirmed stopped. The durable
    // submit intent is committed with SUBMITTING before any final submit call.
    return this.store.tx(()=>{
      let changed=0;
      const table=name=>Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      const hasSubmitTables=table('publisher_submit_intents')&&table('publisher_submit_receipts'),hasPrepareTable=table('publisher_prepare_intents');
      for(const row of this.db.prepare("SELECT * FROM publisher_jobs WHERE state IN ('PREPARING','SUBMITTING')").all()){
        const hasSubmitIntent=hasSubmitTables&&Boolean(this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(row.id));
        const hasSubmitReceipt=hasSubmitTables&&Boolean(this.db.prepare('SELECT 1 FROM publisher_submit_receipts WHERE job_id=?').get(row.id));
        const hasPrepareIntent=hasPrepareTable&&Boolean(this.db.prepare('SELECT 1 FROM publisher_prepare_intents WHERE job_id=?').get(row.id));
        const submitMayHaveStarted=!hasSubmitTables||row.state==='SUBMITTING'||hasSubmitIntent||hasSubmitReceipt;
        const state=submitMayHaveStarted?'UNKNOWN':'BLOCKED',at=new Date().toISOString();
        let old={};try{old=JSON.parse(row.evidence_json||'{}');}catch{}
        const evidence={...old,error:'服务在执行期间停止；原尝试保留，未自动重试',stage:row.state,submissionIntent:hasSubmitTables?hasSubmitIntent:null,
          submitCallMayHaveStarted:submitMayHaveStarted,
          ...(!submitMayHaveStarted?{preparationFailure:{attemptId:row.attempt_id,snapshotHash:row.snapshot_hash,at,finalSubmitNotCalled:true,preparationEffectsMayRemain:hasPrepareIntent},preparationEffectsMayRemain:hasPrepareIntent}: {})};
        changed+=this.db.prepare('UPDATE publisher_jobs SET state=?,evidence_json=?,updated_at=? WHERE id=? AND state=?').run(state,JSON.stringify(evidence),at,row.id,row.state).changes;
        this.store.event(row.workspace,'publisher_startup_attempt_recovered',{job_id:row.id,attempt_id:row.attempt_id,from_state:row.state,to_state:state,submit_intent:hasSubmitIntent,submit_receipt:hasSubmitReceipt,prepare_intent:hasPrepareIntent});
      }
      return changed;
    });
  }
}
