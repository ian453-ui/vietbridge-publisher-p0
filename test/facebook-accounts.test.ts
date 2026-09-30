import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/database.ts';
import {FacebookAccounts} from '../src/facebook-accounts.ts';

test('Facebook accounts persist selection, import local metadata and isolate job identities',()=>{
  const root=mkdtempSync(join(tmpdir(),'publisher-fb-')),configA=join(root,'a.env'),configB=join(root,'b.json');
  writeFileSync(configA,'FB_ACCOUNT_NAME=Account A\nFB_PAGE_ID=1001\nFB_PAGE_NAME=Page A\nFB_PAGE_ACCESS_TOKEN=secret-a\n');
  writeFileSync(configB,JSON.stringify({FB_ACCOUNT_NAME:'Account B',FB_PAGE_ID:'2002',FB_PAGE_NAME:'Page B',FB_PAGE_ACCESS_TOKEN:'secret-b'}));
  chmodSync(configA,0o600);chmodSync(configB,0o600);
  const db=openDatabase(join(root,'test.sqlite')),accounts=new FacebookAccounts(db);
  try{
    const imported=accounts.importLocal('file://'+configA);assert.equal(imported.page_id,'1001');assert.equal(JSON.stringify(imported).includes('secret-a'),false);
    const a=accounts.save(imported),b=accounts.save(accounts.importLocal(configB));accounts.select(b.id);
    assert.equal(new FacebookAccounts(db).selected().id,b.id);
    assert.notEqual(accounts.jobIdentity(a),accounts.jobIdentity(b));
    assert.equal(accounts.resolveJobIdentity('Page A').id,a.id);
    accounts.save({...b,page_id:'3003'});assert.throws(()=>accounts.resolveJobIdentity(`facebook:${b.id}:2002`),/Page 已被修改/);
  }finally{db.close()}
});

test('Facebook account config rejects remote URLs',()=>{const root=mkdtempSync(join(tmpdir(),'publisher-fb-')),db=openDatabase(join(root,'test.sqlite'));try{assert.throws(()=>new FacebookAccounts(db).importLocal('https://example.com/a.env'),/本机文件/)}finally{db.close()}});
test('legacy task identity fails closed when an account name is ambiguous',()=>{const root=mkdtempSync(join(tmpdir(),'publisher-fb-')),db=openDatabase(join(root,'test.sqlite')),file=join(root,'a.env');writeFileSync(file,'FB_PAGE_ID=1');chmodSync(file,0o600);try{const accounts=new FacebookAccounts(db);accounts.save({display_name:'Same',page_name:'Same',page_id:'1',config_url:file});accounts.save({display_name:'Same',page_name:'Same',page_id:'2',config_url:file});assert.throws(()=>accounts.resolveJobIdentity('Same'),/重复/)}finally{db.close()}});
