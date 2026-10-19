import test from 'node:test';
import assert from 'node:assert/strict';
import {randomGroupIds,replaceGroupSelection} from '../src/group-selection.js';

const group=(id,extra={})=>({id,account_id:'a',name:'Travel '+id,enabled:true,membership_status:'JOINED',...extra});
test('random selection obeys account, membership and include/exclude filters without duplicates',()=>{
  const groups=[group('1'),group('2'),group('2'),group('3',{account_id:'b'}),group('4',{enabled:false}),group('5',{membership_status:'STALE'}),group('6',{name:'Visa Travel'})];
  assert.deepEqual(randomGroupIds(groups,'a',100,{include:'travel',exclude:'visa'},()=>0),['1','2']);
  assert.deepEqual(randomGroupIds(groups,'a',1,{},()=>0.99),['6']);
});
test('random count validates, handles no eligible groups and uses bounded partial shuffle',()=>{
  for(const count of [0,-1,1.5,101,NaN])assert.throws(()=>randomGroupIds([],'a',count));
  assert.deepEqual(randomGroupIds([],'a',5),[]);
  const ids=randomGroupIds([group('1'),group('2'),group('3')],'a',2,{},()=>0.5);
  assert.equal(ids.length,2);assert.equal(new Set(ids).size,2);
  assert.throws(()=>randomGroupIds([group('1')],'a',1,{},()=>1),/随机数无效/);
});
test('each round replaces rather than appends selection, and clearing leaves no historical checks',()=>{
  const inputs=['1','2','3'].map(id=>({dataset:{group:id},checked:true,disabled:false,closest:()=>({hidden:false})}));
  replaceGroupSelection(inputs,['2']);assert.deepEqual(inputs.map(x=>x.checked),[false,true,false]);
  replaceGroupSelection(inputs,['3']);assert.deepEqual(inputs.map(x=>x.checked),[false,false,true]);
  replaceGroupSelection(inputs);assert.ok(inputs.every(x=>!x.checked));
});
test('disabled or hidden groups never enter a replacement selection',()=>{
  const inputs=[{dataset:{group:'1'},checked:true,disabled:true,closest:()=>({hidden:false})},{dataset:{group:'2'},checked:true,disabled:false,closest:()=>({hidden:true})}];
  replaceGroupSelection(inputs,['1','2']);assert.ok(inputs.every(x=>!x.checked));
});
