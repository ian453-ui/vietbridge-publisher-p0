import {DatabaseSync} from 'node:sqlite';
import {assertBrowserSkillBinding} from '../src/browser-skill-binding.js';

export const browserSkillScanPath=binding=>binding?`/api/workspaces/${binding.workspace}/proactive/scan`:null;
export function guardBrowserSkillScan({url,input,principal},binding,settingsScope,dbPath,{now=Date.now()}={}){
 if(!binding||url.pathname!==browserSkillScanPath(binding))return false;
 if(principal?.type!=='admin')throw Error('BSK_SCAN_ADMIN_REQUIRED');
 if(url.search||!input||Object.keys(input).join(',')!=='account_id'||input.account_id!==binding.account_id)throw Error('BSK_EXACT_MANUAL_SCAN_REQUIRED');
 if(!settingsScope||settingsScope.workspace!==binding.workspace||settingsScope.account_id!==binding.account_id||settingsScope.actor_id!==binding.actor_id||settingsScope.target_page_id!==binding.target_page_id||now<settingsScope.issued_at||now>=settingsScope.expires_at)throw Error('BSK_CURRENT_OPERATING_SCOPE_REQUIRED');
 const db=new DatabaseSync(dbPath,{readOnly:true});try{assertBrowserSkillBinding(db,binding,{now});}finally{db.close();}return true;
}
