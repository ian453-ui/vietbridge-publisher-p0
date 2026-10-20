import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {completedFailure, renderDashboard} from '../legacy-p0/src/web-ui.ts';

const uncertain = ['UNKNOWN','SUBMITTED_PENDING_CONFIRMATION','RECONCILE_PENDING','PUBLISHED_ID_PENDING','JOB_WAITING_HUMAN'];
test('only explicitly completed failures qualify for historical failure display', () => {
  for (const state of ['FAILED','FAILED_PREFLIGHT','BLOCKED_CAPABILITY']) {
    assert.equal(completedFailure({control_state:'COMPLETED'}, {state}), true);
    for (const control_state of ['RUNNING','NEEDS_ATTENTION','PAUSED','AWAITING_APPROVAL'])
      assert.equal(completedFailure({control_state}, {state}), false);
    assert.equal(completedFailure({control_state:'COMPLETED'}, {state,submit_safety_domain:'MAY_HAVE_SUBMITTED'}), false);
  }
  for (const state of [...uncertain,'FORM_FILLING','PUBLISHED'])
    assert.equal(completedFailure({control_state:'COMPLETED'}, {state}), false);
});

async function display(batches) {
  const nodes = {'#tasks':{}, '#results':{}};
  const source = renderDashboard();
  const views = source.slice(source.indexOf('let batchRenderRevision='), source.indexOf('async function prepareRepublish'));
  const success = s => ['PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_API_WRITTEN_NOT_PUBLISHED','PLATFORM_DELETED'].includes(s);
  const context = vm.createContext({
    completedFailure, success, names:{}, labels:{}, attention:()=>false, phase:()=>100,
    esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),
    $:s=>nodes[s], document:{querySelectorAll:()=>[]}, workspaceParam:'fixture-workspace',
    fetch:async url=>{assert.equal(url,'/api/batches?workspace=fixture-workspace');return {ok:true,json:async()=>({batches})};},
  });
  await vm.runInContext(views+'\nload()',context);
  return nodes;
}
const job = (id,state,extra={}) => ({job_id:id,article_id:id,platform:'facebook',state,...extra});
const batch = (control_state,jobs) => ({batch_id:'fixture',title:'Fixture',control_state,jobs});

test('completed failures render in history with escaped reason and preserve hidden history',async()=>{
  const nodes=await display([batch('COMPLETED',[
    job('ended','FAILED_PREFLIGHT',{failure_reason:'<old upload failure>',can_retry:true}),
    job('hidden','FAILED',{history_hidden:true}),
  ])]);
  assert.doesNotMatch(nodes['#tasks'].innerHTML,/ended|hidden|停止任务/);
  assert.match(nodes['#results'].innerHTML,/历史已结束（最后状态：FAILED_PREFLIGHT）/);
  assert.match(nodes['#results'].innerHTML,/历史尝试原因：&lt;old upload failure&gt;/);
  assert.match(nodes['#results'].innerHTML,/data-history-retry="ended"/);
  assert.doesNotMatch(nodes['#results'].innerHTML,/hidden|data-republish-article/);
});

test('active failures and uncertain submissions retain existing locations and reconciliation controls',async()=>{
  const nodes=await display([
    batch('NEEDS_ATTENTION',[job('active','FAILED')]),
    batch('COMPLETED',uncertain.map(state=>job(state,state)).concat(job('ambiguous-failure','FAILED',{submit_safety_domain:'MAY_HAVE_SUBMITTED'}))),
  ]);
  for(const id of ['active','UNKNOWN','SUBMITTED_PENDING_CONFIRMATION','RECONCILE_PENDING','JOB_WAITING_HUMAN','ambiguous-failure']) {
    assert.ok(nodes['#tasks'].innerHTML.includes('data-preview-job="'+id+'"'));
    assert.ok(!nodes['#results'].innerHTML.includes('data-preview-job="'+id+'"'));
  }
  // Existing PUBLISHED_ID_PENDING history placement is deliberately unchanged.
  assert.match(nodes['#results'].innerHTML,/data-reconcile="PUBLISHED_ID_PENDING"/);
  assert.match(nodes['#tasks'].innerHTML,/data-reconcile="RECONCILE_PENDING"/);
});

test('successful and stopped history keep their prior labels',async()=>{
  const nodes=await display([batch('COMPLETED',[job('published','PUBLISHED')]),batch('TERMINATED',[job('stopped','FAILED')])]);
  assert.match(nodes['#results'].innerHTML,/已停止（最后状态：FAILED）/);
  assert.match(nodes['#results'].innerHTML,/data-republish-article="published"/);
  assert.doesNotMatch(nodes['#results'].innerHTML,/历史已结束/);
});
