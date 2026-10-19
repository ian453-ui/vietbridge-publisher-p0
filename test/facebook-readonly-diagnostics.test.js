import test from 'node:test';
import assert from 'node:assert/strict';
import {runFacebookDiagnostic,readDiagnosticPage,diagnosticLink,safeDiagnosticUrl,classifyDiagnosticView,boundedDiagnosticCleanup} from '../src/facebook-readonly-diagnostics.js';
const snapshot={body:'approved full body',operatorActorId:'61594159443807',targetPageId:'1459220443931651'};
const base='https://business.facebook.com/latest/posts/',url=kind=>base+kind+'/?asset_id='+snapshot.targetPageId;
const data=(links=[],candidates=[],extra={})=>({title:'Business',links,candidates,gridCount:1,rowCount:candidates.length,busy:false,filters:[],pagination:['Next'],rowsCapped:false,emptyNotice:!candidates.length,composerBodyMatches:null,...extra});
function fixture({match=false,error=false,noLinks=false,identityWrong=false}={}){
  let oldCloses=0,oldNavigations=0;const own=[];
  const links=noLinks?[]:['published_posts','drafts','scheduled_posts'].map(kind=>({url:url(kind),label:kind}));
  const old={url:()=>`https://www.facebook.com/profile.php?id=${snapshot.operatorActorId}`,evaluate:async()=>data(links),close:async()=>{oldCloses++;},goto:async()=>{oldNavigations++;throw Error('old navigation forbidden');}};
  const context={pages:()=>[old],newPage:async()=>{let address='';const page={url:()=>address,goto:async target=>{assert.ok(diagnosticLink(target,snapshot.targetPageId));address=target;if(error)throw Error('explicit list load failure');},evaluate:async()=>data([],match&&address.includes('published')?[{text:snapshot.body,exact:true,fullBodyContained:true,itemLabel:'Select item with id 999',links:[]}]:[]),close:async()=>{page.closed=true;}};own.push(page);return page;}};
  return {context,identity:async()=>({healthy:!identityWrong,externalId:snapshot.operatorActorId,targetPageId:snapshot.targetPageId}),own,get oldCloses(){return oldCloses;},get oldNavigations(){return oldNavigations;}};
}
test('only exact observed safe Business asset links are followed; URLs redact secrets',()=>{
  assert.ok(diagnosticLink(url('drafts'),snapshot.targetPageId));for(const bad of [url('published_posts').replace(snapshot.targetPageId,'wrong'),url('composer'),url('drafts')+'&access_token=secret','https://evil.example/latest/posts/?asset_id='+snapshot.targetPageId])assert.equal(diagnosticLink(bad,snapshot.targetPageId),null);
  assert.equal(safeDiagnosticUrl(url('drafts')+'&access_token=secret').includes('secret'),false);assert.equal(classifyDiagnosticView('', 'Bản nháp'),'DRAFT');
});
test('snapshot first, single pass observes three surfaces, never changes/ closes old pages or proves absence',async()=>{
  const f=fixture(),progress=[];const result=await runFacebookDiagnostic({...f,snapshot,progress:v=>progress.push(v.stage)});assert.equal(result.conclusion,'NOT_FOUND_IN_OBSERVED_RANGE');assert.equal(result.absenceProven,false);assert.equal(result.coverage.exhaustive,false);assert.deepEqual(result.coverage.observed.sort(),['DRAFT','PUBLISHED','SCHEDULED']);assert.equal(f.oldCloses,0);assert.equal(f.oldNavigations,0);assert.equal(f.own.length,3);assert.ok(f.own.every(p=>p.closed));assert.deepEqual(progress.slice(0,2),['SCENE','IDENTITY']);assert.equal(result.scene.length,1);
});
test('full normalized candidate with ID gives MATCH, not permission to publish or complete',async()=>{const f=fixture({match:true}),r=await runFacebookDiagnostic({...f,snapshot});assert.equal(r.conclusion,'MATCH');assert.equal(r.matches[0].ids[0],'999');assert.equal(r.absenceProven,false);assert.equal(f.oldNavigations,0);});
test('identity mismatch or absent UI links blocks without guessing or navigating',async()=>{for(const args of [{identityWrong:true},{noLinks:true}]){const f=fixture(args),r=await runFacebookDiagnostic({...f,snapshot});assert.equal(r.conclusion,'BLOCKED');assert.equal(f.own.length,0);assert.equal(f.oldCloses,0);assert.ok(r.errors.length);}});
test('list load errors are retained explicitly, never swallowed as no match',async()=>{const f=fixture({error:true}),r=await runFacebookDiagnostic({...f,snapshot});assert.equal(r.conclusion,'BLOCKED');assert.ok(r.errors.some(e=>e.error==='explicit list load failure'));assert.equal(r.absenceProven,false);});
test('bounded hung scene stops with explicit timeout and no platform navigation',async()=>{const f=fixture();f.context.pages()[0].evaluate=()=>new Promise(()=>{});const r=await runFacebookDiagnostic({...f,snapshot,stepMs:5,budgetMs:20});assert.equal(r.conclusion,'BLOCKED');assert.ok(r.errors.some(e=>e.error==='DIAGNOSTIC_STEP_TIMEOUT'));assert.equal(f.oldCloses,0);assert.equal(f.own.length,0);});
test('cleanup is bounded even if close never resolves',async()=>{await assert.rejects(()=>boundedDiagnosticCleanup(()=>new Promise(()=>{}),5),/CLEANUP_TIMEOUT/);});
test('safe filter query is preserved but link label alone never proves the observed view',async()=>{
  const f=fixture({noLinks:true}),target='https://business.facebook.com/latest/content/?asset_id='+snapshot.targetPageId+'&tab=drafts';assert.equal(diagnosticLink(target,snapshot.targetPageId),target);
  f.context.pages()[0].evaluate=async()=>data([{url:target,label:'Drafts'}]);const r=await runFacebookDiagnostic({...f,snapshot});assert.equal(r.views[0].view,'OTHER');assert.equal(r.coverage.observed.includes('DRAFT'),false);assert.equal(r.conclusion,'INCOMPLETE');assert.equal(r.absenceProven,false);
});
test('hidden progress indicator does not mask a visible empty state or observed navigation tabs',async()=>{
  const hidden={getClientRects:()=>[],innerText:''},tab=label=>({getClientRects:()=>[{}],innerText:label});
  const doc={title:'Business',body:{innerText:'No scheduled posts'},querySelector:()=>null,querySelectorAll:selector=>selector==='[aria-busy="true"],[role="progressbar"]'?[hidden]:selector==='[role="tab"]'?[tab('Published'),tab('Scheduled'),tab('Drafts')]:[]};
  const previousDocument=globalThis.document,previousLocation=globalThis.location;
  try{globalThis.document=doc;globalThis.location={href:url('scheduled_posts')};const result=await readDiagnosticPage({evaluate:fn=>fn({caption:snapshot.body})},snapshot.body);assert.equal(result.busy,false);assert.equal(result.emptyNotice,true);assert.deepEqual(result.availableTabs,['Published','Scheduled','Drafts']);}
  finally{globalThis.document=previousDocument;globalThis.location=previousLocation;}
});
test('observed Business tabs cover Scheduled and Drafts without guessed URLs or a platform write',async()=>{
  const published=url('published_posts'),scheduled=url('scheduled_posts'),draft=url('draft_posts');let address='',clicks=[];
  const old={url:()=>`https://www.facebook.com/profile.php?id=${snapshot.operatorActorId}`,evaluate:async()=>data([{url:published,label:'Content'}])};
  const page={url:()=>address,goto:async target=>{assert.equal(target,published);address=target;},evaluate:async()=>data([],[],{activeTabs:[address===scheduled?'Scheduled':address===draft?'Drafts':'Published'],availableTabs:['Published','Scheduled','Drafts']}),getByRole:(role,options)=>({click:async()=>{assert.equal(role,'tab');assert.equal(options.exact,true);clicks.push(options.name);address=options.name==='Scheduled'?scheduled:draft;}}),close:async()=>{}};
  const result=await runFacebookDiagnostic({context:{pages:()=>[old],newPage:async()=>page},snapshot,identity:async()=>({healthy:true,externalId:snapshot.operatorActorId,targetPageId:snapshot.targetPageId})});
  assert.deepEqual(clicks,['Scheduled','Drafts']);assert.deepEqual(result.coverage.observed.sort(),['DRAFT','PUBLISHED','SCHEDULED']);assert.equal(result.conclusion,'NOT_FOUND_IN_OBSERVED_RANGE');assert.equal(result.absenceProven,false);
});
test('missing observed tab is an explicit coverage error, never an absence proof',async()=>{
  const f=fixture({noLinks:true});f.context.pages()[0].evaluate=async()=>data([{url:url('published_posts'),label:'Content'}]);
  const original=f.context.newPage;f.context.newPage=async()=>{const p=await original();p.evaluate=async()=>data([],[],{activeTabs:['Published'],availableTabs:['Published']});p.getByRole=()=>{throw Error('UNOBSERVED_TAB_CLICK')};return p;};
  const result=await runFacebookDiagnostic({...f,snapshot});
  assert.ok(result.errors.some(e=>e.stage==='TAB'&&e.error==='DIAGNOSTIC_TAB_NOT_OBSERVED'));assert.ok(result.errors.some(e=>e.stage==='COVERAGE'&&e.missing.includes('SCHEDULED')));assert.equal(result.conclusion,'INCOMPLETE');assert.equal(result.absenceProven,false);
});
