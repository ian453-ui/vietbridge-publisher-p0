import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {groupFilterTerms,groupNameMatches} from '../src/group-filters.js';
import {Store} from '../src/store.js';
import {FacebookBrowser} from '../src/facebook-browser.js';

test('group-name include and exclude matching is case-insensitive and name-only',()=>{
  assert.deepEqual(groupFilterTerms(' visa， Tourist ; travel\n'),['visa','tourist','travel']);
  assert.equal(groupNameMatches('China VISA Travel',{exclude:'visa'}),false);
  assert.equal(groupNameMatches('China Travel',{include:'china',exclude:'visa'}),true);
  assert.equal(groupNameMatches('Vietnam Study',{include:'china,travel',exclude:'visa'}),false);
  assert.equal(groupNameMatches('Tourist China',{include:'china,travel',exclude:'visa, tourist'}),false);
  assert.equal(groupNameMatches('Any Group',{exclude:''}),true);
});

test('excluded groups cannot enter a mixed task batch or an automatic publish queue',()=>{
  const store=new Store(join(mkdtempSync(join(tmpdir(),'smo-group-filter-')),'db.sqlite')),ws='ws-vietbridge';
  try{
    const profile=store.saveProfile(ws,{name:'Test',cdp_port:19311,user_data_dir:'/tmp/smo-group-filter'});
    const account=store.saveAccount(ws,{display_name:'Test',expected_identity:'Test',profile_id:profile.id});
    const visa=store.addGroup(ws,{account_id:account.id,name:'China VISA Group',url:'https://www.facebook.com/groups/101'});
    const travel=store.addGroup(ws,{account_id:account.id,name:'China Travel Group',url:'https://www.facebook.com/groups/102'});
    const content=store.createContent(ws,{body:'Approved body',media:[]});
    const input={account_id:account.id,content_ids:[content.id],group_ids:[travel.id,visa.id],group_name_exclude:'visa'};
    assert.throws(()=>store.createGroupJobs(ws,input),/不符合当前名称筛选/);
    assert.equal(store.rows('group_jobs',ws).length,0);
    const [safe]=store.createGroupJobs(ws,{...input,group_ids:[travel.id]});
    const [excluded]=store.createGroupJobs(ws,{...input,group_ids:[visa.id],group_name_exclude:''});
    const browser=new FacebookBrowser(store);browser.runQueue=async()=>{};
    assert.throws(()=>browser.enqueueJobs(ws,[safe.id,excluded.id],{exclude:'visa'}),/当前群组名称筛选/);
    assert.equal(browser.enqueueJobs(ws,[safe.id],{exclude:'visa'}).accepted,1);
  }finally{store.close();}
});
