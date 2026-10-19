import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFacebookPostTime,normalizeProactiveResults,FacebookBrowser} from '../src/facebook-browser.js';
import {verifiedProactiveGroupUrl,facebookPostTarget} from '../src/interaction-target.js';
import {chromium} from 'playwright-core';

const now=Date.parse('2026-10-01T10:00:00Z'),group={id:'g',url:'https://www.facebook.com/groups/123',external_id:'123'};
function row(time,url='https://www.facebook.com/groups/123/posts/456/'){
 return {body:'How can our factory improve recruitment?',time,links:[{url:'https://www.facebook.com/alice',text:'Alice'},{url,text:'post'}]};
}
test('numeric, ISO and Chinese/English/Vietnamese times resolve with a fixed observation time',()=>{
 for(const label of ['2 hours ago','2 h','2 小时前','2 小時前','2 giờ trước'])assert.equal(parseFacebookPostTime(label,now),'2026-10-01T08:00:00.000Z');
 assert.equal(parseFacebookPostTime('5 phút',now),'2026-10-01T09:55:00.000Z');
 assert.equal(parseFacebookPostTime(String(now/1000),now),new Date(now).toISOString());
 assert.equal(parseFacebookPostTime('2026-10-01T09:00:00Z',now),'2026-10-01T09:00:00.000Z');
 assert.equal(parseFacebookPostTime('Just now',now),new Date(now).toISOString());
 for(const value of ['Sponsored','Alice','99999999999999999','2026-10-02T10:00:00Z'])assert.equal(parseFacebookPostTime(value,now),null);
});
test('scan accepts permalink format, verifies host/group, filters old or unknown times and deduplicates',()=>{
 const result=normalizeProactiveResults([
  row('2 小时前','https://www.facebook.com/groups/123/permalink/456/?ref=share'),
  row('1 小时前'),row('2 days ago','https://www.facebook.com/groups/123/posts/789/'),
  row('unknown','https://www.facebook.com/groups/123/posts/999/'),
  row('2 hours ago','https://evil.example/groups/123/posts/100/'),
  row('2 hours ago','https://www.facebook.com/groups/1234/posts/100/'),
 ],group,24,now);
 assert.equal(result.length,1);assert.equal(result[0].external_id,'456');
 assert.equal(result[0].published_at,'2026-10-01T08:00:00.000Z');
 assert.equal(result[0].permalink,'https://www.facebook.com/groups/123/posts/456/');
 assert.equal(normalizeProactiveResults([{...row(null),times:['Alice','3 giờ']}],group,24,now).length,1);
 const photo={...row('2 小时前'),links:[{url:'https://www.facebook.com/photo/?fbid=789&set=gm.456&idorvanity=123',text:''}]};
 assert.equal(normalizeProactiveResults([photo],group,24,now)[0].permalink,'https://www.facebook.com/groups/123/posts/456/');
});
test('empty group feed skeletons are an explicit blocker instead of successful zero scan',async()=>{
 const account={id:'a',profile_id:'p',expected_identity:'Actor',external_id:'123456'};
 const store={account:()=>account,proactiveSettings:()=>({enabled:true,global_enabled:true,account_enabled:true,max_posts_per_group:30}),db:{prepare:()=>({all:()=>[group]})}};
 const browser=new FacebookBrowser(store);browser.profile=()=>({id:'p'});
 browser.inspect=async()=>({healthy:true,externalId:'123456',actualIdentity:'Actor'});
 const page={goto:async()=>{},waitForTimeout:async()=>{},url:()=>group.url,evaluate:async fn=>String(fn).includes('document.body')?'Test group':[],getByRole:()=>({first(){return this},waitFor:async()=>{},getAttribute:async()=> 'true',locator(){return this},innerText:async()=> 'Actor'}),locator:selector=>{if(selector==='body'||selector==='html > body')throw Error('strict mode: Facebook and overlay bodies');return {first(){return this},waitFor:async()=>{},evaluateAll:async()=>[]}}};
 let closed=false;browser.page=async()=>({page,browser:{close:async()=>{closed=true}}});
 await assert.rejects(browser.scanProactiveEngagement('ws','a'),/不能将读取失败当作零结果/);
 assert.equal(closed,true);assert.equal(browser.activeProfiles.size,0);
});
test('vanity group with verified numeric ID accepts a real feed card outside empty article skeletons',async()=>{
 const vanity={id:'g',url:'https://www.facebook.com/groups/dulichtrungquoctutuc2024',external_id:'522768946486257'};
 assert.equal(verifiedProactiveGroupUrl(vanity),'https://www.facebook.com/groups/522768946486257');
 assert.equal(facebookPostTarget('https://www.facebook.com/groups/522768946486257/posts/456/',{groupUrl:verifiedProactiveGroupUrl(vanity)}).postId,'456');
 assert.throws(()=>verifiedProactiveGroupUrl({...vanity,external_id:'other-slug'}),/未可靠绑定/);
 assert.throws(()=>facebookPostTarget('https://www.facebook.com/groups/999/posts/456/',{groupUrl:verifiedProactiveGroupUrl(vanity)}),/不属于冻结目标群组/);
 const chrome=await chromium.launch({...process.env.PUBLISHER_TEST_BROWSER_PATH?{executablePath:process.env.PUBLISHER_TEST_BROWSER_PATH}:{channel:'chrome'},headless:true});
 try{
  const page=await chrome.newPage();
  const originalGetByRole=page.getByRole.bind(page);
  page.getByRole=(role,options)=>role==='button'&&String(options?.name).includes('Your profile')?{first(){return this},waitFor:async()=>{},getAttribute:async()=> 'true'}:role==='dialog'?{locator:()=>({first(){return this},waitFor:async()=>{},innerText:async()=> 'Actor'})}:originalGetByRole(role,options);
  const iso=new Date(Date.now()-60000).toISOString();
  let html=`<html><body><div role="article"></div><div role="article"></div><div role="feed"><div class="card"><a href="https://www.facebook.com/groups/522768946486257/user/42/">Ngọc Huyền</a><time datetime="${iso}">1m</time><div role="button" aria-label="Actions for this post by Ngọc Huyền">More</div><div><span dir="auto">Mọi người cho hỏi lịch trình Trung Quốc tự túc ba ngày nên đi đâu?</span><span dir="auto">Mọi người cho hỏi lịch trình Trung Quốc tự túc ba ngày nên đi đâu?</span><a href="https://www.facebook.com/photo/?fbid=123&set=gm.456&idorvanity=522768946486257">photo</a></div></div></div></body></html>`;
  await page.route('https://www.facebook.com/groups/dulichtrungquoctutuc2024?sorting_setting=CHRONOLOGICAL',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html}));
  const account={id:'a',profile_id:'p',expected_identity:'Actor',external_id:'123456'};
  let ingested;
  const store={account:()=>account,proactiveSettings:()=>({enabled:true,global_enabled:true,account_enabled:true,max_posts_per_group:30,lookback_hours:24}),db:{prepare:()=>({all:()=>[vanity]})},ingestEngagementPosts:(ws,id,rows)=>{ingested=rows;return rows},rankedEngagementCandidates:()=>[]};
  const fb=new FacebookBrowser(store);fb.profile=()=>({id:'p'});fb.inspect=async()=>({healthy:true,externalId:'123456',actualIdentity:'Actor'});fb.page=async()=>({page,browser:{close:async()=>{}}});
  const result=await fb.scanProactiveEngagement('ws','a');
  assert.equal(result.observed,1);assert.equal(result.scanned,1);assert.equal(result.groups,1);
  assert.equal(ingested[0].permalink,'https://www.facebook.com/groups/522768946486257/posts/456/');
  assert.match(ingested[0].body,/lịch trình Trung Quốc/);
  html=html.replace('idorvanity=522768946486257','idorvanity=999');
  await assert.rejects(fb.scanProactiveEngagement('ws','a'),/不能将读取失败当作零结果/);
  await page.close();
 }finally{await chrome.close()}
});
