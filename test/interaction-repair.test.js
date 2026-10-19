import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {reviewFixtureCandidate} from './fixtures/review-engagement.js';
import {FacebookBrowser,normalizeRadarResults} from '../src/facebook-browser.js';
import {themeTarget} from '../src/engagement-review.js';
import {facebookCommentAnchorBoundToPost} from '../src/interaction-target.js';

function fixture(){
 const store=new Store(join(mkdtempSync(join(tmpdir(),'interaction-repair-')),'db.sqlite')),ws='ws-vietbridge';
 const profile=store.saveProfile(ws,{name:'Browser',cdp_port:19621,user_data_dir:'/tmp/interaction-repair'});
 const account=store.saveAccount(ws,{display_name:'Actor',expected_identity:'Actor',external_id:'123456',profile_id:profile.id,execution_transport:'BROWSER'});
 const group=store.addGroup(ws,{account_id:account.id,name:'HR',url:'https://www.facebook.com/groups/123',tags:'招聘',proactive_engagement_enabled:true});
 store.db.prepare("UPDATE facebook_accounts SET session_health='HEALTHY' WHERE id=?").run(account.id);
 store.saveEngagementPolicy(ws,{account_id:account.id,mode:'AUTO_LOW_RISK',topics:'招聘'});
 store.ingestRadarPosts(ws,account.id,[{group_id:group.id,external_id:'456',permalink:group.url+'/posts/456/',author:'Alice',body:'越南工厂招聘怎么提高面试到岗率？',topic:'招聘'}]);
 const candidate=reviewFixtureCandidate(store,ws,store.buildEngagementCandidates(ws,account.id)[0]);
 return {store,ws,account,group,candidate};
}

test('policy edits reclassify unsent candidates and preserve locked outcomes',()=>{
 const {store,ws,account,candidate}=fixture();try{
  store.saveEngagementPolicy(ws,{account_id:account.id,mode:'AUTO_LOW_RISK',topics:'无关主题'});
  assert.equal(store.buildEngagementCandidates(ws,account.id)[0].state,'SKIP');
  store.saveEngagementPolicy(ws,{account_id:account.id,mode:'AUTO_LOW_RISK',topics:'招聘'});
  assert.equal(store.buildEngagementCandidates(ws,account.id)[0].state,'REPLY_CANDIDATE');
  const reservation=store.reserveReplyQuota(ws,candidate.id).reservation;
  store.beginAutoReply(ws,candidate.id,reservation.id);
  store.markAutoReplyUnknown(ws,candidate.id,reservation.id,'Readback pending');
  store.buildEngagementCandidates(ws,account.id);
  assert.equal(store.engagementCandidate(ws,candidate.id).state,'UNKNOWN');
  assert.equal(store.engagementCandidate(ws,candidate.id).reason,'Readback pending');
 }finally{store.close()}
});

test('radar recognizes canonical permalink and photo links but rejects another host or group',()=>{
 const group={id:'g',url:'https://www.facebook.com/groups/123'};
 const row=url=>({body:'招聘怎么改善？',links:[{url,text:'post'}]});
 const rows=normalizeRadarResults([row('https://www.facebook.com/groups/123/permalink/456/?ref=share'),row('https://www.facebook.com/photo/?fbid=789&set=gm.456&idorvanity=123'),row('https://evil.example/groups/123/posts/789/'),row('https://www.facebook.com/groups/1234/posts/789/')],group,'招聘');
 assert.equal(rows.length,1);assert.equal(rows[0].permalink,'https://www.facebook.com/groups/123/posts/456/');
});

test('shadow proactive settings block writes and verified facts survive a rescan',()=>{
 const {store,ws,account,group}=fixture();try{
  store.saveProactiveSettings(ws,{account_id:account.id,enabled:true,auto_like:true,auto_reply:true,mode:'SHADOW',project_topics:'招聘'});
  const item={group_id:group.id,external_id:'999',body:'招聘最新劳动法规定怎么处理加班？'};
  const [post]=store.ingestEngagementPosts(ws,account.id,[item]);
  store.addFactSource(ws,post.id,{source_url:'https://example.gov.vn/rule',supports_reply:true});
  assert.equal(store.ingestEngagementPosts(ws,account.id,[item])[0].state,'FACT_VERIFIED');
  assert.throws(()=>store.reserveProactivePost(ws,post.id,'Reviewed reply'),/影子模式/);
  assert.equal(store.rows('engagement_daily_slots',ws).length,0);
 }finally{store.close()}
});

for(const verified of [true,false])test(`browser radar reply ${verified?'confirms readback':'locks ambiguous submission without retry'}`,async()=>{
 const {store,ws,account,group,candidate}=fixture();let presses=0,closed=0;
 const browser=new FacebookBrowser(store);
 browser.inspect=async()=>({healthy:true,externalId:'123456',actualIdentity:'Actor'});
 const box={count:async()=>1,fill:async()=>{},textContent:async()=>candidate.draft,press:async()=>{presses++}};
 const actor={first(){return this},waitFor:async()=>{},getAttribute:async()=>'true',locator(){return this},innerText:async()=>'Actor'};
 const page={goto:async()=>{},waitForTimeout:async()=>{},url:()=>group.url+'/posts/456/',evaluate:async()=>'越南工厂招聘怎么提高面试到岗率？',getByRole:()=>actor,locator:selector=>selector==='body'?{innerText:async()=>'越南工厂招聘怎么提高面试到岗率？'}:{last:()=>box}};
 const fresh={...page,close:async()=>{},locator:selector=>selector==='div[role="article"]'?{evaluateAll:async()=>verified}:page.locator(selector)};
 browser.page=async()=>({page,browser:{close:async()=>{closed++},contexts:()=>[{newPage:async()=>fresh}]}});
 try{
  const result=await browser.replyRadarCandidate(ws,candidate.id);
  assert.equal(result.state,verified?'REPLIED':'UNKNOWN');assert.equal(presses,1);assert.equal(closed,1);
  assert.equal(store.facebookView(ws).quotaEvents[0].state,verified?'CONSUMED':'RESERVED');
  assert.equal(browser.activeProfiles.size,0);
  await assert.rejects(browser.replyRadarCandidate(ws,candidate.id),/已有|候选|只有/);
  assert.equal(presses,1);
 }finally{store.close()}
});
test('before-submit failure releases only its own reviewed reservation, never another candidate or UNKNOWN',async()=>{
 const {store,ws,account,group,candidate}=fixture();let presses=0;
 try{store.ingestRadarPosts(ws,account.id,[{group_id:group.id,external_id:'457',permalink:group.url+'/posts/457/',author:'Bob',body:'招聘怎么改善邀约率？',topic:'招聘'}]);const other=store.buildEngagementCandidates(ws,account.id).find(c=>store.comment(ws,c.comment_id).external_id==='457');reviewFixtureCandidate(store,ws,other);const held=store.reserveReplyQuota(ws,other.id).reservation;
 const browser=new FacebookBrowser(store);browser.inspect=async()=>({healthy:true,externalId:'123456',actualIdentity:'Actor'});const box={count:async()=>1,fill:async()=>{throw Error('Synthetic fill failed before Enter');},press:async()=>{presses++;}},actor={first(){return this},waitFor:async()=>{},getAttribute:async()=>'true',locator(){return this},innerText:async()=>'Actor'},page={goto:async()=>{},waitForTimeout:async()=>{},url:()=>group.url+'/posts/456/',evaluate:async()=>'越南工厂招聘怎么提高面试到岗率？',getByRole:()=>actor,locator:selector=>selector==='body'?{innerText:async()=>'越南工厂招聘怎么提高面试到岗率？'}:{last:()=>box}};browser.page=async()=>({page,browser:{close:async()=>{}}});await assert.rejects(browser.replyRadarCandidate(ws,candidate.id),/Synthetic fill failed/);assert.equal(presses,0);assert.equal(store.engagementCandidate(ws,candidate.id).state,'REPLY_CANDIDATE');assert.equal(store.db.prepare('SELECT state FROM quota_events WHERE subject_id=?').get(candidate.id).state,'RELEASED');assert.equal(store.db.prepare('SELECT state FROM quota_events WHERE id=?').get(held.id).state,'RESERVED');assert.equal(store.quotaStatus(ws,account.id).used,1);store.beginAutoReply(ws,other.id,held.id);store.markAutoReplyUnknown(ws,other.id,held.id,'ambiguous');assert.throws(()=>store.releaseQuota(ws,held.id),/禁止释放/);assert.equal(store.db.prepare('SELECT state FROM quota_events WHERE id=?').get(held.id).state,'RESERVED');}
 finally{store.close();}
});
test('missing real source or unreviewed draft fails before any browser connection',async()=>{const {store,ws,account,candidate}=fixture();const browser=new FacebookBrowser(store);let connections=0;browser.inspect=async()=>{connections++;throw Error('must not inspect');};browser.page=async()=>{connections++;throw Error('must not connect');};try{store.db.prepare("UPDATE radar_posts SET permalink='https://www.facebook.com/groups/123' WHERE external_id='456'").run();await assert.rejects(browser.replyRadarCandidate(ws,candidate.id),/稳定|帖子 ID|链接/);assert.equal(connections,0);store.db.prepare("UPDATE radar_posts SET permalink='https://www.facebook.com/groups/123/posts/456/' WHERE external_id='456'").run();store.db.prepare('UPDATE engagement_draft_reviews SET reviewed_at=NULL WHERE candidate_id=?').run(candidate.id);await assert.rejects(browser.replyRadarCandidate(ws,candidate.id),e=>e.code==='DRAFT_REVIEW_REQUIRED');assert.equal(connections,0);assert.equal(store.rows('quota_events',ws).length,0);}finally{store.close();}});
test('browser Inbox reads bound Business Page, keeps actor independent and excludes radar parent scenes',async()=>{
 const {store,ws,account}=fixture();const publisher=new UnifiedPublisher(store);store.db.prepare("UPDATE facebook_accounts SET identity_type='PAGE',operator_actor_id='123456',target_page_id='654321' WHERE id=?").run(account.id);const content=publisher.importContent(ws,{source_id:'published-inbox',revision:'r1',body:'Confirmed Page body',media:[]}),job=publisher.createPageJob(ws,{account_id:account.id,content_id:content.id});store.db.prepare("UPDATE publisher_jobs SET state='PUBLISHED',evidence_json=? WHERE id=?").run(JSON.stringify({verified:true,id:'889',url:'https://www.facebook.com/123456/posts/889',method:'BROWSER_PUBLISHED_LIST_READBACK'}),job.id);const vanity=store.addGroup(ws,{account_id:account.id,name:'Vanity group',url:'https://www.facebook.com/groups/visitcn'});store.db.prepare('INSERT INTO published_posts(id,workspace,account_id,group_id,job_id,post_url,observed_at) VALUES(?,?,?,?,?,?,?)').run('vanity-post',ws,account.id,vanity.id,'old-group-job','https://www.facebook.com/groups/777/posts/890/',new Date().toISOString());const browser=new FacebookBrowser(store),navigations=[];let current='',closed=0;
 browser.inspect=async()=>({healthy:true,externalId:'123456',actualIdentity:'Actor'});const actor={first(){return this},waitFor:async()=>{},getAttribute:async()=>'true',locator(){return this},innerText:async()=>'Actor'};
 const article=(url,body,id)=>{const node={querySelectorAll:selector=>selector==='a[href]'?[{href:'https://www.facebook.com/profile.php?id=555&comment_id=Y29tbWVudA%3D%3D',innerText:'Alice'},{href:url+(url.includes('?')?'&':'?')+'comment_id='+id,innerText:'link'}]:[{innerText:body,closest:()=>node}]};return node;};
 const page={goto:async url=>{navigations.push(url);current=url;},url:()=>current,waitForTimeout:async()=>{},getByRole:()=>actor,locator:selector=>({evaluateAll:async(fn,arg)=>{if(selector==='a[href]'){assert.equal(arg,'654321');return fn([{href:'https://www.facebook.com/654321/posts/888/'},{href:'https://www.facebook.com/999999/posts/999/'}],arg);}return fn([article(arg.postId==='889'?'https://www.facebook.com/permalink.php?story_fbid=pfbidAbc123&id=123456':'https://www.facebook.com/654321/posts/888/','招聘怎么提高到岗率？',arg.postId==='889'?'903':'901'),article('https://www.facebook.com/654321/posts/999/','招聘另一篇问题？','902')],arg);}})};browser.page=async()=>({page,browser:{close:async()=>{closed++;}}});
 try{const result=await browser.syncBrowserInbox(ws,account.id);assert.deepEqual(result,{mode:'BROWSER',posts:2,comments:2,limited:true,skippedVanityGroups:1});assert.equal(navigations[0],'https://www.facebook.com/profile.php?id=654321');assert.deepEqual(navigations.slice(1),['https://www.facebook.com/123456/posts/889/','https://www.facebook.com/654321/posts/888/']);assert.equal(store.account(ws,account.id).external_id,'123456');assert.equal(store.account(ws,account.id).target_page_id,'654321');const inbox=store.rows('fb_comments',ws).filter(c=>['901','902','903'].includes(c.external_id));assert.deepEqual(inbox.map(c=>c.external_id).sort(),['901','903']);assert.equal(closed,1);assert.equal(browser.activeProfiles.size,0);}finally{store.close();}
});
test('Page reply target requires exact Publisher receipt and accepts only bound opaque comment anchors',()=>{
 const {store,ws,account}=fixture();try{
  const publisher=new UnifiedPublisher(store);store.db.prepare("UPDATE facebook_accounts SET identity_type='PAGE',operator_actor_id='123456',target_page_id='654321' WHERE id=?").run(account.id);
  const content=publisher.importContent(ws,{source_id:'reply-bound',revision:'r1',body:'Page',media:[]}),job=publisher.createPageJob(ws,{account_id:account.id,content_id:content.id});
  const post=store.upsertPagePost(ws,account.id,{id:'123456_889',permalink_url:'https://www.facebook.com/123456/posts/889'});
  store.upsertComments(ws,post.id,[{external_id:'903',author:'Alice',body:'招聘怎么改善？'}]);const comment=store.db.prepare('SELECT * FROM fb_comments WHERE post_id=? AND external_id=?').get(post.id,'903'),candidate={account_id:account.id,comment_id:comment.id};
  assert.throws(()=>themeTarget(store,ws,candidate),/Business Page/);
  store.db.prepare("UPDATE publisher_jobs SET state='PUBLISHED',evidence_json=? WHERE id=?").run(JSON.stringify({verified:true,id:'889',url:'https://www.facebook.com/123456/posts/889'}),job.id);
  const target=themeTarget(store,ws,candidate);assert.equal(target.postId,'889');
  assert.equal(facebookCommentAnchorBoundToPost('https://www.facebook.com/permalink.php?story_fbid=pfbidAbc123&id=123456&comment_id=903',target,'903'),true);
  assert.equal(facebookCommentAnchorBoundToPost('https://www.facebook.com/profile.php?id=123456&comment_id=903',target,'903'),false);
  assert.equal(facebookCommentAnchorBoundToPost('https://www.facebook.com/permalink.php?story_fbid=pfbidAbc123&id=999999&comment_id=903',target,'903'),false);
  assert.equal(facebookCommentAnchorBoundToPost('https://www.facebook.com/permalink.php?story_fbid=pfbidAbc123&id=123456&comment_id=904',target,'903'),false);
 }finally{store.close();}
});
for(const kind of ['LIKE','INITIAL_REPLY'])test(`closing GROUP during ${kind} preparation blocks final dispatch and releases only new own quota`,async()=>{
 const {store,ws,account,group}=fixture();let clicks=0,enters=0,closed=0;
 try{store.saveProactiveSettings(ws,{account_id:account.id,enabled:true,auto_like:kind==='LIKE',auto_reply:kind==='INITIAL_REPLY',project_topics:'招聘'});const body='我们公司在越南工厂招聘很慢，请问大家如何改善面试到岗率？',[post]=store.ingestEngagementPosts(ws,account.id,[{group_id:group.id,external_id:'888',permalink:group.url+'/posts/888/',author:'Bob',body}]),reply='先记录邀约、面试和到岗各环节。';
 const browser=new FacebookBrowser(store);browser.inspect=async()=>({healthy:true,externalId:'123456',actualIdentity:'Actor'});const actor={first(){return this},waitFor:async()=>{},getAttribute:async()=>'true',locator(){return this},innerText:async()=>'Actor'},like={count:async()=>1,getAttribute:async()=>{store.setGroupProactive(ws,group.id,false);return 'Like';},click:async()=>{clicks++;}},box={count:async()=>1,fill:async()=>{store.setGroupProactive(ws,group.id,false);},textContent:async()=>reply,press:async()=>{enters++;}},article={getByRole:()=>({first:()=>like}),locator:()=>({last:()=>box})},page={goto:async()=>{},waitForTimeout:async()=>{},url:()=>post.permalink,evaluate:async()=>body,getByRole:()=>actor,locator:selector=>selector==='body'?{innerText:async()=>body}:{filter:()=>({first:()=>article})}};browser.page=async()=>({page,browser:{close:async()=>{closed++;},contexts:()=>[{newPage:async()=>{throw Error('dispatch must never start');}}]}});
 const result=await browser.executeProactiveEngagement(ws,post.id,reply);assert.equal(result.state,'CANDIDATE');assert.equal(clicks,0);assert.equal(enters,0);const actions=store.rows('engagement_actions',ws);assert.equal(actions.length,1);assert.equal(actions[0].action_type,kind);assert.equal(actions[0].state,'FAILED_CONFIRMED_ABSENT');assert.equal(store.db.prepare('SELECT state FROM interaction_budget WHERE owner=?').get('proactive:'+actions[0].id).state,'RELEASED');assert.equal(store.rows('engagement_daily_slots',ws)[0].state,'RELEASED');assert.equal(closed,1);assert.equal(browser.activeProfiles.size,0);}
 finally{store.close();}
});
