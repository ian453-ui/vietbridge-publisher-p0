import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderDashboard} from '../src/web-ui.ts';

test('active tasks precede content selection and completed history follows',()=>{
  const html=renderDashboard();
  assert.ok(html.indexOf('id="active-tasks"')<html.indexOf('id="mode"'));
  assert.ok(html.indexOf('id="mode"')<html.indexOf('id="results"'));
  assert.match(html,/id="content-platform-filter"/);
  assert.match(html,/筛选可发布内容/);
  assert.match(html,/id="reconcile-all"/);
  assert.match(html,/核对这条/);
  assert.match(html,/id="toggle-all-content"/);
  assert.match(html,/取消全选/);
  assert.match(html,/id="include-published" checked/);
  assert.match(html,/包含已发布内容/);
  assert.match(html,/id="republish" autocomplete="off"> 允许重新发布/);
  assert.doesNotMatch(html,/id="republish"[^>]* checked/);
  assert.match(html,/input\[data-platform\]:checked/);
  assert.equal((html.match(/id="tasks"/g)||[]).length,1);
});
