import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {FacebookBusinessBrowser,guardBrowserDialogs} from '../src/publisher-core/facebook-business-browser.ts';

test('stale CDP dialog dismissal rejection is handled and marks readback unsafe',async()=>{
  const context=new EventEmitter();let observed=0;
  guardBrowserDialogs(context,()=>observed++);
  context.emit('dialog',{dismiss:()=>Promise.reject(Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing'))});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(observed,1);
});

test('an unexpected dialog prevents browser readback from being marked verified',async()=>{
  const browser=new FacebookBusinessBrowser({id:'a',page_id:'1459220443931651',page_name:'LP'},17921,'61594159443807');
  browser.unexpectedDialog=true;
  await assert.rejects(()=>browser.readback('Approved body'),/FACEBOOK_BROWSER_UNEXPECTED_DIALOG/);
  assert.equal(browser.verified,false);
});
