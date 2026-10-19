import {DatabaseSync} from 'node:sqlite';

const fail=code=>{throw Error(code);};
const scopeKeys=['version','workspace','account_id','actor_id','target_page_id','issued_at','expires_at','max_groups','max_daily_actions','max_followups'];
const settingKeys=['account_id','mode','enabled','project_topics','scan_interval_min','lookback_hours','max_posts_per_group','daily_limit','max_followups','auto_like','auto_reply','fact_search','global_enabled','account_enabled'];
const bool=v=>v===true||v===1?true:v===false||v===0?false:fail('OPERATING_SETTINGS_BOOLEAN_REQUIRED');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));

// This is a finite business-settings scope, not a browser/platform execution
// policy. It cannot issue permits, enable a scheduler or change account bindings.
export function validateOperatingSettingsScope(scope){
 if(!exact(scope,scopeKeys)||Object.keys(scope).length!==scopeKeys.length||scope.version!==1||!/^ws-[a-z0-9-]+$/i.test(scope.workspace||'')||typeof scope.account_id!=='string'||!scope.account_id.trim()||!/^\d+$/.test(scope.actor_id||'')||!/^\d+$/.test(scope.target_page_id||'')||!Number.isSafeInteger(scope.issued_at)||!Number.isSafeInteger(scope.expires_at)||scope.expires_at<=scope.issued_at||scope.expires_at-scope.issued_at>28800000||scope.max_groups!==2||scope.max_daily_actions!==3||scope.max_followups!==5)fail('FINITE_OPERATING_SETTINGS_SCOPE_REQUIRED');
 return scope;
}
export function operatingSettingsView(scope,now=Date.now()){
 if(!scope)return null;validateOperatingSettingsScope(scope);
 return {available:now>=scope.issued_at&&now<scope.expires_at,workspace:scope.workspace,accountId:scope.account_id,maxGroups:2,maxDailyActions:3,maxFollowups:5,maxLookbackHours:24,maxPostsPerGroup:10,expiresAt:new Date(scope.expires_at).toISOString(),grantsPlatformExecution:false};
}
export function operatingSettingsPaths(scope){
 if(!scope)return [];
 return [`/api/workspaces/${scope.workspace}/proactive/settings`,`/api/workspaces/${scope.workspace}/proactive/groups/toggle-bulk`];
}
export function guardOperatingSettings({url,input,principal},scope,dbPath,{now=()=>Date.now()}={}){
 if(!scope||!operatingSettingsPaths(scope).includes(url.pathname))return false;
 validateOperatingSettingsScope(scope);
 if(principal?.type!=='admin')fail('OPERATING_SETTINGS_ADMIN_REQUIRED');
 if(now()<scope.issued_at||now()>=scope.expires_at)fail('OPERATING_SETTINGS_WINDOW_EXPIRED');
 if(url.search||!input||Array.isArray(input)||typeof input!=='object'||input.account_id!==scope.account_id)fail('OPERATING_SETTINGS_ACCOUNT_MISMATCH');
 const db=new DatabaseSync(dbPath,{readOnly:true});
 try{
  const account=db.prepare('SELECT * FROM facebook_accounts WHERE workspace=? AND id=?').get(scope.workspace,scope.account_id);
  if(!account||account.operator_actor_id!==scope.actor_id||account.external_id!==scope.actor_id||account.target_page_id!==scope.target_page_id||!account.enabled)fail('OPERATING_SETTINGS_MAPPING_CHANGED');
  if(url.pathname.endsWith('/settings')){
   if(!exact(input,settingKeys))fail('OPERATING_SETTINGS_FIELD_NOT_ALLOWED');
   const current=db.prepare('SELECT * FROM proactive_settings WHERE workspace=? AND account_id=?').get(scope.workspace,scope.account_id);
   if(!current)fail('OPERATING_SETTINGS_EXISTING_ACCOUNT_REQUIRED');
   // The store preserves omitted values. Validate exactly that resulting
   // configuration, so a partial save cannot retain legacy limits (5/30/168).
   const effective={...current,project_topics:JSON.parse(current.project_topics_json),...input};
   // These are existing stop/mode guards, never opened by ordinary edits.
   for(const k of ['global_enabled','account_enabled'])if(k in input&&bool(input[k])&&!current[k])fail('OPERATING_SETTINGS_STOP_GUARD_CANNOT_OPEN');
   if('mode' in input&&input.mode!==current.mode&&input.mode!=='SHADOW')fail('OPERATING_SETTINGS_MODE_EXPANSION_FORBIDDEN');
   if(!['SHADOW','LIMITED_AUTO'].includes(effective.mode))fail('OPERATING_SETTINGS_MODE_EXPANSION_FORBIDDEN');
   for(const k of ['enabled','auto_like','auto_reply','fact_search','global_enabled','account_enabled'])bool(effective[k]);
   const ranges={scan_interval_min:[15,1440],lookback_hours:[1,24],max_posts_per_group:[1,10],daily_limit:[1,3],max_followups:[0,5]};
   for(const [k,[min,max]] of Object.entries(ranges))if(!Number.isSafeInteger(effective[k])||effective[k]<min||effective[k]>max)fail('OPERATING_SETTINGS_LIMIT_EXCEEDED');
   if(!(typeof effective.project_topics==='string'&&effective.project_topics.length<=1000||Array.isArray(effective.project_topics)&&effective.project_topics.length<=30&&effective.project_topics.every(x=>typeof x==='string'&&x.length<=100)))fail('OPERATING_SETTINGS_TOPICS_INVALID');
  }else{
   if(!exact(input,['account_id','changes'])||!Array.isArray(input.changes)||input.changes.length>4||input.changes.some(x=>!exact(x,['group_id','enabled'])||Object.keys(x).length!==2||typeof x.group_id!=='string'||typeof x.enabled!=='boolean')||new Set(input.changes.map(x=>x.group_id)).size!==input.changes.length)fail('OPERATING_SETTINGS_EXACT_GROUP_CHANGES_REQUIRED');
   const rows=db.prepare('SELECT id,enabled,membership_status,proactive_engagement_enabled FROM facebook_groups WHERE workspace=? AND account_id=?').all(scope.workspace,scope.account_id);
   const enabled=new Set(rows.filter(g=>g.proactive_engagement_enabled).map(g=>g.id));
   for(const change of input.changes){const group=rows.find(g=>g.id===change.group_id);if(!group||change.enabled&&(!group.enabled||group.membership_status!=='JOINED'))fail('OPERATING_SETTINGS_JOINED_GROUP_REQUIRED');if(change.enabled)enabled.add(group.id);else enabled.delete(group.id);}
   if(enabled.size>scope.max_groups)fail('OPERATING_SETTINGS_GROUP_LIMIT_2');
  }
  return true;
 }finally{db.close();}
}
