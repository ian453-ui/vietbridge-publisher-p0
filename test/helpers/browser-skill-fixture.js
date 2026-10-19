import assert from 'node:assert/strict';
export function runtime(f){
 return {version:1,workspace:f.w.id,account_id:f.account.id,actor_id:f.account.operator_actor_id,target_page_id:f.account.target_page_id,browser_instance_id:'e91ba5d3',issued_at:Date.now()-1000,expires_at:Date.now()+3600000,evidence:{source:'USER_PROFILE_INSTRUCTIONS',approval_thread_id:'mock-user-thread',approval_message_id:'mock-selected-instance'}};
}
export const identity=b=>[{url:`https://www.facebook.com/${b.actor_id}/ad_center/`},{url:`https://business.facebook.com/latest/inbox/all/?asset_id=${b.target_page_id}`}];
export function candidate(f){
 f.store.db.prepare("UPDATE facebook_accounts SET session_health='HEALTHY' WHERE id=?").run(f.account.id);
 f.store.saveProactiveSettings(f.w.id,{account_id:f.account.id,enabled:true,auto_like:false,auto_reply:true,daily_limit:3,max_posts_per_group:10,project_topics:'越南工厂,招聘'});
 const group=f.store.addGroup(f.w.id,{account_id:f.account.id,name:'Help',url:'https://www.facebook.com/groups/12345/',proactive_engagement_enabled:true});
 const [post]=f.store.ingestEngagementPosts(f.w.id,f.account.id,[{group_id:group.id,external_id:'56789',permalink:'https://www.facebook.com/groups/12345/posts/56789/',body:'我们公司在越南工厂招聘很慢，请问大家如何改善面试到岗率？',author:'Author',published_at:new Date().toISOString()}]);
 return {group,post,reply:'先统计邀约、面试、到岗各环节，再核对主要流失原因。'};
}
export function mockClient(binding,post,{failAt=null,ambiguous=false,wrongIdentity=false,wrongReadback=false}={}){
 let submits=0,filled='',tabs=0,stops=0;const calls=[];
 return {calls,get submits(){return submits;},get stops(){return stops;},start:async instance=>{calls.push(['start',instance]);if(failAt==='start')throw Error('disconnected');assert.equal(instance,'e91ba5d3');return 'mock-session';},stop:async()=>{stops++;},tab:async(s,url)=>{calls.push(['tab',url]);return ++tabs;},navigate:async()=>{},observe:async()=>{},closeTab:async()=>{},read:async(s,tab,fn,args)=>{
  const doc={url:post.permalink,visibleText:'Safe visible page',navLinks:identity(binding),rows:[{body:post.body,links:[{url:post.permalink,text:'1 h'}],times:['1 h']}],selectorCount:args?.selector?1:null,target:{body:post.body,boxCount:1,boxSelector:'html > body > div:nth-of-type(1)',boxText:filled,buttons:[],comments:[]}};
  if(wrongIdentity)doc.navLinks=identity({...binding,actor_id:'999'});if(ambiguous)doc.target.boxCount=2;
  if(submits)doc.target.comments=[{body:filled,links:[{url:`https://www.facebook.com/${wrongReadback?'999':binding.actor_id}`},{url:post.permalink+'?comment_id=12399'}]}];
  if(failAt==='readback'&&tab>1)throw Error('readback unavailable');return doc;
 },input:async(s,tab,command,selector,value)=>{calls.push([command,selector,value]);if(command==='fill'){if(failAt==='fill')throw Error('fill failed');filled=value;}else{submits++;if(failAt==='submit')throw Error('dispatched timeout');}}};
}
