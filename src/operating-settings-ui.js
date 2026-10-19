// Displaying this capability never opens browser/platform execution routes.
export function operatingSettingsCanEdit(scope,workspace,accountId,now=Date.now()){
 return Boolean(scope&&scope.available===true&&scope.grantsPlatformExecution===false&&scope.workspace===workspace&&scope.accountId===accountId&&scope.maxGroups===2&&scope.maxDailyActions===3&&scope.maxFollowups===5&&Date.parse(scope.expiresAt)>now);
}
export function readOperatingSettingsHeader(headers){
 try{return JSON.parse(decodeURIComponent(headers?.get?.('x-publisher-operating-settings')||'null'));}catch{return null;}
}
export function applyOperatingSettingsLimits(document,scope){
 for(const [id,max] of [['proactive-daily-limit',scope.maxDailyActions],['proactive-followups',scope.maxFollowups],['proactive-lookback',scope.maxLookbackHours],['proactive-max-posts',scope.maxPostsPerGroup]]){
  const input=document.getElementById(id);if(!input)continue;input.max=String(max);if(Number(input.value)>max)input.value=String(max);
 }
 for(const id of ['proactive-global','proactive-account']){const input=document.getElementById(id);if(input){input.disabled=!input.checked;input.title='可停止互动；本次普通设置不重新打开停止开关';}}
 const mode=document.getElementById('proactive-mode');if(mode){mode.disabled=true;mode.title='本次普通设置不提升执行模式';}
}
