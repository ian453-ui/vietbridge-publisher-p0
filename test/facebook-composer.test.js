import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {FacebookBrowser,postComposer,groupPostCandidates,canonicalGroupPostUrl,chromeCommandMatchesProfile} from '../src/facebook-browser.js';

test('Chrome profile check accepts a data-directory argument at the end only for the exact port and path',()=>{
  const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile={cdp_port:17921,user_data_dir:'/Users/test/Library/Application Support/VietBridge/chrome-profiles/lp-visa'};
  const command=`${chrome} --no-startup-window --remote-debugging-port=17921 --user-data-dir=${profile.user_data_dir}`;
  assert.equal(chromeCommandMatchesProfile(command,profile),true);
  assert.equal(chromeCommandMatchesProfile(command,{...profile,cdp_port:17922}),false);
  assert.equal(chromeCommandMatchesProfile(command,{...profile,user_data_dir:profile.user_data_dir+'-other'}),false);
});

test('composer targets the modal editor, not the nested Create post heading dialog',async()=>{
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{const page=await browser.newPage();await page.setContent('<div role="dialog" aria-label="Notifications"></div><div role="dialog" aria-modal="true"><div role="dialog" aria-label="Create post">Create post</div><div role="textbox" contenteditable="true" aria-placeholder="Create a public post…"></div><input type="file"><button>Post</button></div>');
    const {dialog,box}=postComposer(page);await box.fill('Approved body');
    assert.equal(await box.textContent(),'Approved body');assert.equal(await dialog.locator('input[type=file]').count(),1);
  }finally{await browser.close();}
});

test('manual group-post readback finds the image-backed permalink and rejects other groups',async()=>{
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{const page=await browser.newPage();await page.setContent('<section><span>LP Travel Visa</span><p>Approved opening and final CTA</p><a href="https://www.facebook.com/photo/?fbid=9&set=gm.456&idorvanity=123">Image</a></section>');
    assert.deepEqual(await groupPostCandidates(page,'https://www.facebook.com/groups/123','Approved opening and final CTA','LP Travel Visa'),['https://www.facebook.com/groups/123/posts/456/']);
    assert.deepEqual(await groupPostCandidates(page,'https://www.facebook.com/groups/999','Approved opening and final CTA','LP Travel Visa'),[]);
    assert.throws(()=>canonicalGroupPostUrl('https://www.facebook.com/groups/999/posts/456/','https://www.facebook.com/groups/123'),/不属于目标群组/);
    assert.equal(canonicalGroupPostUrl('https://www.facebook.com/groups/123/permalink/456/','https://www.facebook.com/groups/123'),'https://www.facebook.com/groups/123/posts/456/');
    assert.equal(canonicalGroupPostUrl('https://www.facebook.com/photo/?set=gm.456&idorvanity=123','https://www.facebook.com/groups/123'),'https://www.facebook.com/groups/123/posts/456/');
    assert.equal(canonicalGroupPostUrl('https://www.facebook.com/story.php?story_fbid=456&id=123','https://www.facebook.com/groups/123'),'https://www.facebook.com/groups/123/posts/456/');
  }finally{await browser.close();}
});

test('failed before-submit group job is retryable; submitted job is not',()=>{
  const store=new Store(join(mkdtempSync(join(tmpdir(),'fb-composer-')),'db.sqlite'));
  try{const ws='ws-vietbridge',profile=store.saveProfile(ws,{name:'FB',cdp_port:19215,user_data_dir:'/tmp/fb-composer-test'}),account=store.saveAccount(ws,{display_name:'Test',expected_identity:'Test',profile_id:profile.id}),group=store.addGroup(ws,{account_id:account.id,name:'Group',url:'https://www.facebook.com/groups/123'}),content=store.createContent(ws,{body:'Approved body',media:[]}),job=store.createGroupJobs(ws,{account_id:account.id,content_ids:[content.id],group_ids:[group.id]})[0],fb=new FacebookBrowser(store);
    store.beginPrepare(ws,job.id,'Test');store.failBeforeSubmit(ws,job.id,'Composer textbox missing');
    fb.runQueue=async()=>{};assert.equal(fb.enqueueJobs(ws,[job.id]).accepted,1);
    fb.activeProfiles.clear();store.beginPrepare(ws,job.id,'Test');store.finishPrepare(ws,job.id,{});store.beginSubmit(ws,job.id,{});
    assert.throws(()=>fb.enqueueJobs(ws,[job.id]),/未提交过/);
  }finally{store.close();}
});

test('queue marks later unstarted jobs blocked when the first job fails',async()=>{
  const store=new Store(join(mkdtempSync(join(tmpdir(),'fb-queue-')),'db.sqlite'));
  try{const ws='ws-vietbridge',profile=store.saveProfile(ws,{name:'FB',cdp_port:19217,user_data_dir:'/tmp/fb-queue-test'}),account=store.saveAccount(ws,{display_name:'Test',expected_identity:'Test',profile_id:profile.id}),group1=store.addGroup(ws,{account_id:account.id,name:'Group 1',url:'https://www.facebook.com/groups/123'}),group2=store.addGroup(ws,{account_id:account.id,name:'Group 2',url:'https://www.facebook.com/groups/456'}),content=store.createContent(ws,{body:'Approved body',media:[]}),jobs=store.createGroupJobs(ws,{account_id:account.id,content_ids:[content.id],group_ids:[group1.id,group2.id]}),fb=new FacebookBrowser(store);
    fb.publishJob=async()=>{throw new Error('身份核验失败')};
    await fb.runQueue(ws,jobs,[profile.id]);
    assert.equal(store.job(ws,jobs[0].id).state,'PENDING');
    assert.equal(store.job(ws,jobs[1].id).state,'BLOCKED');
    assert.match(store.job(ws,jobs[1].id).last_action,/身份核验失败/);
  }finally{store.close();}
});

test('manual reconciliation checks legacy UNKNOWN job without a pre-submit baseline',async()=>{
  const store=new Store(join(mkdtempSync(join(tmpdir(),'fb-reconcile-')),'db.sqlite'));
  try{
    const ws='ws-vietbridge',profile=store.saveProfile(ws,{name:'FB',cdp_port:19216,user_data_dir:'/tmp/fb-reconcile-test'}),account=store.saveAccount(ws,{display_name:'Test',expected_identity:'Test',profile_id:profile.id}),group=store.addGroup(ws,{account_id:account.id,name:'Group',url:'https://www.facebook.com/groups/123'}),content=store.createContent(ws,{body:'Approved body',media:[]}),job=store.createGroupJobs(ws,{account_id:account.id,content_ids:[content.id],group_ids:[group.id]})[0],fb=new FacebookBrowser(store);
    store.beginPrepare(ws,job.id,'Test');store.finishPrepare(ws,job.id,{automatic:true});store.markUnknown(ws,job.id,'readback timeout');
    let candidates=[];const page={goto:async()=>{},waitForTimeout:async()=>{},evaluate:async()=>candidates,close:async()=>{}};
    fb.page=async()=>({browser:{contexts:()=>[{newPage:async()=>page}],close:async()=>{}},page});
    fb.verifyGroupPost=async()=>true;
    await assert.rejects(fb.reconcileJob(ws,job.id,''),/未找到匹配帖子/);
    assert.equal(store.job(ws,job.id).state,'UNKNOWN');
    candidates=['https://www.facebook.com/groups/123/posts/456/'];
    const result=await fb.reconcileJob(ws,job.id,'');
    assert.equal(result.state,'PUBLISHED');assert.equal(result.post_url,candidates[0]);
  }finally{store.close();}
});
