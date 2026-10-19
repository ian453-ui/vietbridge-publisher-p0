import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

test('every shipped browser module parses as a complete module',()=>{
 for(const name of ['client.js','unified-client.js','publisher-form-state.js','group-selection.js','group-filters.js','publisher-access-ui.js','publication-selection.js','scoped-confirmation-ui.js']){
  const path=fileURLToPath(new URL('../src/'+name,import.meta.url));
  const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
  assert.equal(result.status,0,name+': '+result.stderr);
 }
});
test('legacy group confirmation remains inside the task function before creation; scoped tasks use individual confirmation',()=>{
 const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
 const start=source.indexOf('async function createGroupTasks('),end=source.indexOf('\nlet groupRefreshTimer',start);
 const functionSource=source.slice(start,end);
 assert.match(functionSource,/if\(autoPublish&&!fb\.scopedExecution\?\.supported&&!window\.confirm\(/);
 assert.ok(functionSource.indexOf('window.confirm(')<functionSource.indexOf('await request('));
 assert.match(functionSource,/for\(const job of eligible\).*await confirmScopedAction/s);
 assert.match(functionSource,/job_ids:\[job\.id\]/);
});
