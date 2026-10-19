import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FacebookBrowser,normalizeGroupLinks,normalizeRadarResults,identityMatches,profileIdFromUrl} from '../src/facebook-browser.js';

test('active actor and stable Page ID are required; management headings are not identities',()=>{
  const account={expected_identity:'VietBridge Group',external_id:'61592080580015'};
  assert.equal(profileIdFromUrl('https://www.facebook.com/profile.php?id=61592080580015'),'61592080580015');
  assert.equal(identityMatches('VietBridge Group','61592080580015',account),true);
  assert.equal(identityMatches('Manage Page','61592080580015',account),false);
  assert.equal(identityMatches('VietBridge Group','other-page',account),false);
  assert.equal(identityMatches('Ian Liu','61592080580015',account),false);
  assert.equal(identityMatches('VietBridge Group',null,account),false);
});

test('joined group extraction excludes navigation and post URLs and deduplicates',()=>{
  assert.deepEqual(normalizeGroupLinks([
    {name:'导航',url:'https://www.facebook.com/groups/joins/'},
    {name:' 搜索 ',url:'https://www.facebook.com/groups/search/'},
    {name:' 企业  交流群 ',url:'https://www.facebook.com/groups/123/?ref=share'},
    {name:'重复',url:'https://www.facebook.com/groups/123/'},
    {name:'帖子',url:'https://www.facebook.com/groups/123/posts/456/'},
  ]),[{name:'企业 交流群',url:'https://www.facebook.com/groups/123'}]);
});
test('topic radar keeps only canonical post links inside the selected group and caps results',()=>{const group={id:'g1',url:'https://www.facebook.com/groups/123'},rows=[{body:'越南工厂怎么招聘？',links:[{text:'Alice',url:'https://www.facebook.com/alice'},{text:'post',url:'https://www.facebook.com/groups/123/posts/456/?ref=share'}]},{body:'wrong group',links:[{text:'post',url:'https://www.facebook.com/groups/999/posts/777/'}]},{body:'duplicate',links:[{text:'post',url:'https://www.facebook.com/groups/123/posts/456/'}]}];assert.deepEqual(normalizeRadarResults(rows,group,'招聘'),[{group_id:'g1',external_id:'456',permalink:'https://www.facebook.com/groups/123/posts/456/',author:'Alice',body:'越南工厂怎么招聘？',topic:'招聘'}]);});
test('sync distinguishes login from wrong Page identity without touching existing groups',async()=>{
  const fb=new FacebookBrowser({account:()=>({profile_id:'p',expected_identity:'VietBridge Group'})});
  fb.profile=()=>({});
  let closes=0;
  fb.page=async(profile,options)=>{assert.deepEqual(options,{reconcile:true,isolated:true});return {page:{close:async()=>{closes++;}},browser:{close:async()=>{closes++;}}};};
  fb.inspect=async()=>({healthy:false,blocker:'WRONG_IDENTITY',actualIdentity:'Ian Liu'});
  await assert.rejects(fb.discoverGroups('ws','a'),/切换为企业 Page/);
  fb.inspect=async()=>({healthy:false,blocker:'FACEBOOK_LOGIN_REQUIRED'});
  await assert.rejects(fb.discoverGroups('ws','a'),/V1 API 授权不等于 V2 浏览器登录/);
  assert.equal(closes,4);
});

test('group discovery holds one isolated read-only session across identity and load failure',async()=>{
  const fb=new FacebookBrowser({account:()=>({profile_id:'p'})});fb.profile=()=>({id:'p'});
  let acquisitions=0,closedPages=0,closedConnections=0;
  const session={page:{goto:async()=>{throw Error('group load timeout');},close:async()=>{closedPages++;}},browser:{close:async()=>{closedConnections++;}}};
  fb.page=async(profile,options)=>{acquisitions++;assert.deepEqual(options,{reconcile:true,isolated:true});return session;};
  fb.inspect=async(ws,id,options)=>{assert.equal(options.session,session);assert.equal(closedConnections,0);return {healthy:true,actualIdentity:'LP Travel Visa'};};
  await assert.rejects(fb.discoverGroups('ws','a'),/group load timeout/);
  assert.equal(acquisitions,1);assert.equal(closedPages,1);assert.equal(closedConnections,1);
});
