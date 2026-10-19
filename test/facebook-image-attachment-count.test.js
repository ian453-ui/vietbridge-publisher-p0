import test from 'node:test';
import assert from 'node:assert/strict';
import {FacebookBusinessBrowser,waitForImageAttachmentCount} from '../src/publisher-core/facebook-business-browser.ts';

function pageWithCounts(values){
  let reads=0;
  return {getByRole(role,{name}){assert.equal(role,'button');assert.equal(name,'Remove photo');return {count:async()=>values[Math.min(reads++,values.length-1)]};},waitForTimeout:async()=>{},get reads(){return reads;}};
}

test('Meta attachment control may appear after file chooser completion',async()=>{
  const page=pageWithCounts([0,0,1]);
  await waitForImageAttachmentCount(page,1,1000);
  assert.equal(page.reads,3);
});

test('missing or extra attachments fail closed before readiness and submit',async()=>{
  await assert.rejects(()=>waitForImageAttachmentCount(pageWithCounts([0]),1,2),/图片数量/);
  await assert.rejects(()=>waitForImageAttachmentCount(pageWithCounts([2]),1,1000),/图片数量/);
});

test('full form preparation tolerates delayed image control and still runs strict readiness',async()=>{
  const caption='Approved LP body';let body='',counts=0,readiness=0,uploaded=0;
  const page={goto:async()=>{},waitForTimeout:async()=>{},evaluate:async()=> 'Post to LP Public',
    getByLabel:()=>({waitFor:async()=>{},fill:async value=>{body=value;},innerText:async()=>body}),
    getByText:()=>({click:async()=>{}}),waitForEvent:async()=>({setFiles:async files=>{uploaded=files.length;}}),
    getByRole:(role,{name}={})=>{
      if(role==='combobox')return {count:async()=>1};
      if(role==='button'&&name==='Publish')return {isEnabled:async()=>true};
      if(role==='button'&&name==='Remove photo')return {count:async()=>counts++<2?0:1};
      if(role==='radio')return {isChecked:async()=>true};
      if(role==='switch')return {isChecked:async()=>false};
      throw Error(`unexpected ${role} ${name}`);
    }};
  const browser=new FacebookBusinessBrowser({id:'lp',page_id:'1459220443931651',page_name:'LP'},17921,'61594159443807');
  browser.browser={contexts:()=>[{newPage:async()=>page}]};browser.readiness=async()=>{readiness++;return {};};
  await browser.fill(caption,['/tmp/approved.jpg']);
  assert.equal(uploaded,1);assert.equal(body,caption);assert.equal(readiness,1);assert.equal(counts,3);
});
