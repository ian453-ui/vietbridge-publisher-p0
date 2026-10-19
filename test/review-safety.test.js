import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {reviewFixtureCandidate} from './fixtures/review-engagement.js';
import {apiEnabled,assertPageIdentity} from '../src/facebook-engagement.js';

test('API identity must match selected account even when names match',()=>{
  assert.throws(()=>assertPageIdentity({external_id:'1'},{status:'ready',page_id:'2'}),/Page ID/);
  assert.throws(()=>assertPageIdentity({external_id:'1'},{status:'ready'}),/Page ID/);
  assert.doesNotThrow(()=>assertPageIdentity({external_id:'1'},{status:'ready',page_id:'1'}));
});
test('client API Page ID stays separate from browser profile identity',()=>{const path=join(mkdtempSync(join(tmpdir(),'page-identity-')),'account.env');writeFileSync(path,'FB_PAGE_ID=1459220443931651\n',{mode:0o600});const account={external_id:'61594159443807',config_url:path};assert.doesNotThrow(()=>assertPageIdentity(account,{status:'ready',page_id:'1459220443931651'}));assert.throws(()=>assertPageIdentity(account,{status:'ready',page_id:'61594159443807'}),/Page ID/);});
test('browser-only account skips Page API without changing browser identity',()=>{const path=join(mkdtempSync(join(tmpdir(),'browser-only-')),'account.env');writeFileSync(path,'FB_PAGE_ID=1459220443931651\nFB_API_ENABLED=false\n',{mode:0o600});assert.equal(apiEnabled({config_url:path}),false);assert.equal(apiEnabled({external_id:'61594159443807'}),true)});
test('submitted reservation cannot be released and restart preserves uncertainty',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'review-safety-')),'db.sqlite');
 let s=new Store(path);
 try {
  const w='ws-vietbridge',p=s.saveProfile(w,{name:'test',cdp_port:19422,user_data_dir:'/tmp/review-safety'});
  const a=s.saveAccount(w,{display_name:'test',external_id:'123456',profile_id:p.id});
  s.saveEngagementPolicy(w,{account_id:a.id,mode:'AUTO_LOW_RISK',topics:'工厂'});
  const post=s.upsertPagePost(w,a.id,{id:'123456_456',permalink_url:'https://www.facebook.com/123456/posts/456/'});
  s.upsertComments(w,post.id,[{external_id:'789',author:'test',body:'工厂怎么排班？'}]);
  const c=reviewFixtureCandidate(s,w,s.buildEngagementCandidates(w,a.id)[0]),r=s.reserveReplyQuota(w,c.id).reservation;
  s.beginAutoReply(w,c.id,r.id);
  assert.throws(()=>s.releaseQuota(w,r.id),/禁止释放/);
  s.close();s=new Store(path);
  assert.equal(s.engagementCandidate(w,c.id).state,'UNKNOWN');
  assert.throws(()=>s.releaseQuota(w,r.id),/禁止释放/);
 }finally{s.close();}
});
