import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertFacebookReady} from '../src/facebook-mcp-connector.ts';
import {browserPageConfig} from '../src/facebook-business-browser.ts';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {FacebookAccount} from '../src/facebook-accounts.ts';

test('Facebook requires exact ready status, not a substring in a reason',()=>{
  assert.doesNotThrow(()=>assertFacebookReady({status:'ready'}));
  assert.throws(()=>assertFacebookReady({status:'reauth-required',reason:'not ready'}),/reauth-required/);
  assert.throws(()=>assertFacebookReady({status:'temporarily-unavailable',reason:'网络错误'}),/网络错误/);
  assert.throws(()=>assertFacebookReady(null),/unknown/);
});

test('blocked Page API routes the approved Page to its separate browser identity',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'fb-browser-route-')),'account.env');
  writeFileSync(file,'FB_PAGE_ID=1459220443931651\nFB_API_ENABLED=false\nFB_BROWSER_CDP_PORT=17921\nFB_BROWSER_PAGE_ID=61594159443807\n');
  const account={page_id:'1459220443931651',config_url:file} as FacebookAccount;
  assert.deepEqual(browserPageConfig(account),{port:17921,browserPageId:'61594159443807'});
  assert.throws(()=>browserPageConfig({...account,page_id:'61594159443807'}),/Page ID 与任务账号不一致/);
});
