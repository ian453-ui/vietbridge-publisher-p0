import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BrowserSkillClient} from '../src/browser-skill-binding.js';
import {BrowserSkillPublicationDriver} from '../src/browser-skill-publication.js';

function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'bsk-publication-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const asset=join(root,'approved.png'),bytes=Buffer.from('mock approved PNG bytes');writeFileSync(asset,bytes);
 const binding={browser_instance_id:'e91ba5d3',workspace:'ws-test',account_id:'account',actor_id:'123',target_page_id:'456'};
 const snapshot={platform:'facebook',transport:'BROWSER_SKILL',operation:'FACEBOOK_PAGE_PUBLISH',profileDir:null,cdpPort:null,credentialRef:null,body:'Approved full body\nSecond paragraph',expectedIdentity:'LP Travel Visa',profileId:'bsk:e91ba5d3',workspace:'ws-test',accountId:'account',operatorActorId:'123',externalId:'123',targetPageId:'456',executionRef:{kind:'BROWSER_SKILL',instanceId:'e91ba5d3',bindingHash:'frozen-binding'},assetMetadata:[{ordinal:0,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}],contentHash:'content-hash',payloadHash:'payload-hash',...options.snapshot};
 let state='library',body=options.draft||'',mediaCount=0,submits=0,writes=0,expired=false;const calls=[];
 const client={
  start:async id=>{calls.push(['start',id]);return 'owned';},stop:async s=>{calls.push(['stop',s]);},
  tab:async(s,url)=>{calls.push(['tab',s,url]);return 1;},activate:async()=>{},
  observe:async()=>{calls.push(['observe']);return {text:'@e1 button "Create a post"\n@e2 menuitem "Post"\n@e3 button "Write something..."\n@e4 textbox "What\'s on your mind, LP Travel Visa?"\n@e5 button "Photo/video"\n@e6 button "Next"\n@e7 button "Post"'+(options.ambiguous?'\n@e8 button "Post"':'')};},
  refInput:async(s,tab,command,ref,value,opts)=>{calls.push([command,ref,value,opts]);if(command==='fill'){if(options.failFill)throw Error('fill_target_changed');assert.deepEqual(opts,{noClear:true});assert.equal(body,'');body=value;return;}if(ref==='@e1')state='menu';if(ref==='@e2'||ref==='@e3')state='editor';if(ref==='@e6'){state='settings';if(options.expireAtNext)expired=true;}if(ref==='@e7'){submits++;state='published';if(options.failSubmit)throw Error('submit_outcome_unknown');}},
  upload:async(s,tab,ref,path)=>{calls.push(['upload',ref,path]);assert.equal(path,asset);if(options.failUpload)throw Error('upload_outcome_unknown');mediaCount=options.mediaCount??1;},
  read:async()=>{calls.push(['read']);const editor=['editor','settings'].includes(state)?{text:'Create post LP Travel Visa Sharing with Public',boxCount:1,boxLabel:"What's on your mind, LP Travel Visa?",audience:'PUBLIC',body,mediaCount,mediaPreviews:mediaCount?[{source:'blob:https://www.facebook.com/approved-upload',width:128,height:128}]:[]}:null;
   return {url:'https://www.facebook.com/123',publishNow:true,visibleText:options.warning?'security check':'Publish now',navLinks:[{url:`https://www.facebook.com/${options.wrongActor?'999':'123'}/ad_center/`},{url:'https://business.facebook.com/latest/inbox/all/?asset_id=456'}],editor,rows:state==='published'?[{body:options.readbackBody??snapshot.body,links:[{url:'https://www.facebook.com/123'},{url:options.readbackUrl??'https://www.facebook.com/123/posts/observed-pfbid/'}],mediaCount:options.readbackMediaCount??1,times:options.readbackTimes??[String(Math.floor(Date.now()/1000))]}]:[]};}
 };
 const adapter={binding,client,current:()=>({profileId:'bsk:e91ba5d3',fingerprint:options.changedBinding?'changed':'frozen-binding'})};
 const guards={assertScope:()=>{calls.push(['scope']);if(expired)throw Error('PERMIT_EXPIRED');},proveHistory:async()=>options.history!==false};
 return {asset,snapshot,adapter,client,calls,driver:()=>new BrowserSkillPublicationDriver(snapshot,adapter,guards),onWrite:async()=>{writes++;if(options.failClaim)throw Error('claim_failed');},get submits(){return submits;},get writes(){return writes;}};
}

test('native argv has explicit session/tab/ref, no-clear and one upload without shell or auto-start',async()=>{
 const calls=[],c=new BrowserSkillClient({executable:'/mock/bsk',run:async(file,args,opts)=>{calls.push({file,args,opts});return {stdout:'{"ok":true}'};}});
 await c.refInput('owned',42,'fill','@e7','exact body',{noClear:true});await c.upload('owned',42,'@e8','/mock/approved.png');
 assert.deepEqual(calls[0].args,['fill','--ref','@e7','--session','owned','--tab-id','42','--value','exact body','--no-clear','--json']);
 assert.deepEqual(calls[1].args,['upload','--ref','@e8','--file','/mock/approved.png','--session','owned','--tab-id','42','--timeout','30s','--json']);
 assert.ok(calls.every(x=>x.opts.shell===false&&x.opts.env.BSK_AUTO_START==='0'));
 assert.throws(()=>c.refInput('owned',42,'fill','@e0','body'));assert.throws(()=>c.upload('owned',42,'@e1','relative.png'));assert.equal(calls.length,2);
});
for(const patch of [{transport:'BROWSER'},{profileDir:'/legacy/chrome'},{cdpPort:17921},{credentialRef:'legacy'},{profileId:'legacy'},{targetPageId:'999'},{operatorActorId:'999'},{executionRef:{kind:'BROWSER_SKILL',instanceId:'wrong',bindingHash:'frozen-binding'}}])test('legacy or changed authority is rejected before IPC '+JSON.stringify(patch),t=>{
 const f=fixture(t,{snapshot:patch});assert.throws(f.driver);assert.equal(f.calls.length,0);
});
test('empty composer uses no-clear, exact original media, one submit and observed URL only',async t=>{
 const f=fixture(t),d=f.driver();await d.prepare(f.snapshot,[f.asset],f.onWrite);assert.equal(f.writes,1);assert.equal(f.submits,0);assert.equal(f.calls.filter(c=>c[0]==='fill').length,1);assert.equal(f.calls.filter(c=>c[0]==='upload').length,1);
 await d.submit();assert.equal(f.submits,1);await assert.rejects(d.submit(),/ONE_SUBMIT/);const r=await d.readback(f.snapshot);assert.equal(r.url,'https://www.facebook.com/123/posts/observed-pfbid/');assert.equal(r.bodyUrlVerified,true);assert.equal(r.mediaVerified,true);assert.equal(r.verified,true);assert.match(r.observedTimes[0],/^\d{10}$/);await d.close();assert.deepEqual(f.calls.at(-1),['stop','owned']);
});
test('different existing draft is never cleared or filled',async t=>{
 const f=fixture(t,{draft:'User draft'}),d=f.driver();await assert.rejects(d.prepare(f.snapshot,[f.asset],f.onWrite),/DRAFT_NOT_OVERWRITTEN/);assert.equal(f.calls.filter(c=>['fill','upload'].includes(c[0])).length,0);assert.equal(f.submits,0);await assert.rejects(d.prepare(f.snapshot,[f.asset],f.onWrite),/ONE_PREPARATION/);
});
test('identical prefilled body is verified without typing',async t=>{
 const f=fixture(t,{draft:'Approved full body\nSecond paragraph'}),d=f.driver();await d.prepare(f.snapshot,[f.asset],f.onWrite);assert.equal(f.calls.filter(c=>c[0]==='fill').length,0);
});
for(const option of [{history:false},{failClaim:true},{wrongActor:true},{warning:true},{failFill:true},{failUpload:true},{mediaCount:0},{mediaCount:2}])test('preparation uncertainty blocks submit and never retries '+JSON.stringify(option),async t=>{
 const f=fixture(t,option),d=f.driver();await assert.rejects(d.prepare(f.snapshot,[f.asset],f.onWrite));assert.equal(f.submits,0);await assert.rejects(d.submit());assert.equal(d.failureEvidence().retryAllowed,false);assert.ok(f.calls.filter(c=>c[0]==='upload').length<=1);
});
test('changed image bytes and malformed group URL block before browser start',async t=>{
 const f=fixture(t),d=f.driver();writeFileSync(f.asset,'different');await assert.rejects(d.prepare(f.snapshot,[f.asset],f.onWrite),/MEDIA_CHANGED/);assert.equal(f.calls.length,0);
 const g=fixture(t,{snapshot:{operation:'FACEBOOK_GROUP_PUBLISH',groupUrl:'https://evil.example/groups/123/'}}),gd=g.driver();await assert.rejects(gd.prepare(g.snapshot,[g.asset],g.onWrite),/FROZEN_GROUP/);assert.equal(g.calls.filter(c=>c[0]==='start').length,0);
});
test('deadline expiring at Next prevents final Post',async t=>{
 const f=fixture(t,{expireAtNext:true}),d=f.driver();await d.prepare(f.snapshot,[f.asset],f.onWrite);await assert.rejects(d.submit(),/PERMIT_EXPIRED/);assert.equal(f.submits,0);assert.equal(d.failureEvidence().submitted,false);
});
test('unknown final click never allows second submit, fresh readback remains available',async t=>{
 const f=fixture(t,{failSubmit:true}),d=f.driver();await d.prepare(f.snapshot,[f.asset],f.onWrite);await assert.rejects(d.submit(),/outcome_unknown/);assert.equal(d.failureEvidence().submitted,true);await assert.rejects(d.submit(),/ONE_SUBMIT/);assert.equal(f.submits,1);assert.equal((await d.readback(f.snapshot)).bodyUrlVerified,true);
});
for(const option of [{readbackBody:'comment contains Approved full body Second paragraph'},{readbackUrl:'https://evil.example/123/posts/forged/'},{readbackUrl:'https://www.facebook.com/999/posts/another-page/'}])test('readback requires exact message and observed correct-owner Facebook link '+JSON.stringify(option),async t=>{
 const f=fixture(t,option),d=f.driver();await d.prepare(f.snapshot,[f.asset],f.onWrite);await d.submit();await assert.rejects(d.readback(f.snapshot),/READBACK_NOT_PROVEN/);await assert.rejects(d.submit());assert.equal(f.submits,1);
});
