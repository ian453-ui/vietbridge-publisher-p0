import {ScopedOperations} from '../../src/scoped-operations.js';
import {BrowserSkillFacebook} from '../../src/browser-skill-facebook.js';
import {unifiedDrivers} from '../../src/unified-drivers.js';
import {runtime,identity} from './browser-skill-fixture.js';

export function publicationClient(binding,options={}){
 let url='',state='library',body='',mediaCount=0,submits=0,starts=0,tabId=0;const calls=[];
 return {calls,get submits(){return submits;},get starts(){return starts;},
  start:async instance=>{calls.push(['start',instance]);await options.onStart?.();starts++;state='library';body='';mediaCount=0;return 'mock-owned-'+starts;},
  stop:async session=>{calls.push(['stop',session]);},
  tab:async(session,value)=>{calls.push(['tab',session,value]);url=value;return ++tabId;},
  activate:async(session,tab)=>{calls.push(['activate',session,tab]);},
  observe:async()=>({text:'@e1 button "Create a post"\n@e2 menuitem "Post"\n@e3 button "Write something..."\n@e4 textbox "What\'s on your mind, LP?"\n@e5 button "Photo/video"\n@e6 button "Next"\n@e7 button "Post"'}),
  refInput:async(session,tab,command,ref,value,opts)=>{calls.push([command,ref,value,opts]);if(command==='fill'){if(options.failAt==='fill')throw Error('fill_target_changed');body=value;}else{if(ref==='@e2'||ref==='@e3')state='editor';if(ref==='@e6')state='settings';if(ref==='@e7'){submits++;state='published';if(options.failAt==='submit')throw Error('submit_outcome_unknown');}}await options.onEvent?.(command,ref);},
  upload:async(session,tab,ref,path)=>{calls.push(['upload',ref,path]);if(options.failAt==='upload')throw Error('upload_outcome_unknown');mediaCount=1;await options.onEvent?.('upload',ref);},
  read:async()=>{
   const group=url.match(/\/groups\/([1-9]\d*)/),post=group?`https://www.facebook.com/groups/${group[1]}/posts/${70000+submits}/`:`https://www.facebook.com/${binding.actor_id}/posts/${70000+submits}/`;
   if(state==='published'&&options.failAt==='readback')throw Error('readback_unavailable');
   return {url,membership:options.membership??'JOINED',publishNow:options.publishNow!==false,visibleText:options.warning?'security check':options.pendingApproval?'Post is pending approval':'Publish now',navLinks:identity(options.wrongActor?{...binding,actor_id:'999'}:binding),editor:['editor','settings'].includes(state)?{text:'Create post LP Sharing with Public',body,boxCount:1,boxLabel:"What's on your mind, LP?",audience:'PUBLIC',mediaCount,mediaPreviews:mediaCount?[{source:'blob:https://www.facebook.com/approved-upload',width:128,height:128}]:[]}:null,rows:state==='published'?[{author:{source:'MAIN_POST_AUTHOR_HEADING',regionCount:1,links:[{url:`https://www.facebook.com/${options.wrongAuthor?'999':binding.actor_id}`}]},body:options.readbackBody??body,mediaCount:options.readbackMediaCount??1,times:options.readbackTimes??[String(Math.floor(Date.now()/1000))],links:[{url:`https://www.facebook.com/${options.wrongAuthor?'999':binding.actor_id}`},{url:options.readbackUrl??post}]}]:[]};
  }
 };
}
export function wirePublication(f,options={}){
 f.store.db.prepare("UPDATE facebook_accounts SET session_health='HEALTHY' WHERE id=?").run(f.account.id);
 const binding=runtime(f),client=publicationClient(binding,options),skill=new BrowserSkillFacebook(f.store,{binding,client,now:options.now});
 f.facebook.browserSkill=skill;f.executor.drivers=unifiedDrivers(f.facebook);
 const policy={...f.policy,profile_id:'bsk:e91ba5d3',...(options.policy||{})};
 f.scoped=new ScopedOperations(f.executor,f.facebook,{policy,mediaRoots:[f.root],snapshotRoot:f.executor.snapshotRoot,now:options.now});f.executor.scopedOperations=f.scoped;
 return {binding,client,skill,policy};
}
