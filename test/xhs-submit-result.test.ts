import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyXhsSubmit} from '../src/xhs-submit-result.ts';
test('accepted review completes delivery but does not claim moderation approval',()=>{
  assert.equal(classifyXhsSubmit('已提交，等待平台审核',{}),'PUBLISHED_ID_PENDING');
  assert.equal(classifyXhsSubmit('发布成功 PostID: abc123',{}),'PUBLISHED');
  assert.equal(classifyXhsSubmit('发布成功',{}),'PUBLISHED_ID_PENDING');
  assert.throws(()=>classifyXhsSubmit('审核中',{isError:true}));
  assert.throws(()=>classifyXhsSubmit('发布失败，等待平台审核',{}));
  assert.throws(()=>classifyXhsSubmit('timeout',{}));
});
