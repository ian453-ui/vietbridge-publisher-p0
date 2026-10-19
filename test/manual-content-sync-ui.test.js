import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the shipped source card with a tiny DOM fixture; no browser process.
function card(statusValue,{postError=false,refreshError=false}={}){
 const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('function showContentSync(){'),source.indexOf('\nnew MutationObserver(',source.indexOf('function showContentSync(){')));
 const button={disabled:true},status={textContent:''},panel={isConnected:true,querySelector:s=>s==='pre'?status:button};let reads=0,posts=0,updates=0;
 const context={core:{unified:true},route:'v1',workspace:'ws-fixture',selectedPublishingAccount:()=>({id:'fixture-account'}),selectedFacebookAccount:()=>null,document:{querySelector:()=>({closest:()=>({before:()=>{}})}),getElementById:()=>null,createElement:()=>panel},encodeURIComponent,Date,get:async()=>{reads++;if(refreshError&&reads>1)throw Error('read failed');return statusValue;},request:async(path,input)=>{posts++;assert.equal(path,'/api/content-sync/run');assert.deepEqual(JSON.parse(JSON.stringify(input)),{workspace:'ws-fixture',account_id:'fixture-account'});if(postError){statusValue={...statusValue,manualPermission:{canRun:false,reason:'MANUAL_SYNC_ALREADY_ATTEMPTED'}};throw Error('CONTENT_SYNC_FAILED');}return {...statusValue,manualPermission:{canRun:false}};},checkGptUpdates:async()=>{updates++;}};
 vm.runInNewContext(code+'\nshowContentSync();',context);
 return {button,status,context,flush:()=>new Promise(r=>setImmediate(r)),reads:()=>reads,posts:()=>posts,updates:()=>updates};
}

test('source card honors one-run permission and leaves failed consumed attempts disabled',async()=>{
 const denied=card({enabled:true,automatic:false,running:false,manualPermission:{canRun:false}});await denied.flush();assert.equal(denied.button.disabled,true);assert.match(denied.status.textContent,/本次许可已使用/);assert.equal(denied.posts(),0);
 const allowed=card({enabled:true,automatic:false,running:false,manualPermission:{canRun:true}},{postError:true});await allowed.flush();assert.equal(allowed.button.disabled,false);await allowed.button.onclick();assert.equal(allowed.posts(),1);assert.equal(allowed.reads(),2);assert.equal(allowed.button.disabled,true);assert.equal(allowed.updates(),0);
});

test('failed refresh keeps source card disabled; successful once refreshes read-only content view',async()=>{
 const failed=card({enabled:true,automatic:false,running:false,manualPermission:{canRun:true}},{postError:true,refreshError:true});await failed.flush();await failed.button.onclick();assert.equal(failed.button.disabled,true);assert.match(failed.status.textContent,/CONTENT_SYNC_FAILED/);
 const succeeded=card({enabled:true,automatic:false,running:false,manualPermission:{canRun:true}});await succeeded.flush();await succeeded.button.onclick();assert.equal(succeeded.button.disabled,true);assert.equal(succeeded.posts(),1);assert.equal(succeeded.updates(),1);
});
