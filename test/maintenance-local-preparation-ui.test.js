import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenancePreparationView,draftVersionButtons,executionButton} from '../src/unified-client.js';

test('read-only maintenance shows local version confirmation and masks even an old executable permit without mutating its frozen scope',()=>{
 const original={jobs:[{id:'fixture-job',state:'DRAFT',canExecute:true,execution:{mode:'SINGLE_USE',canExecute:true,permitStatus:'AVAILABLE',scopeHash:'frozen-scope'},snapshot:{platform:'facebook',body:'Frozen caption',media:['fixture.png']}}]},before=JSON.stringify(original),view=maintenancePreparationView(original,'read-only'),job=view.jobs[0];
 assert.equal(view.localPreparationOnly,true);assert.equal(job.canExecute,false);assert.equal(job.execution.canExecute,false);assert.equal(job.execution.scopeHash,'frozen-scope');assert.equal(JSON.stringify(original),before);
 const buttons=draftVersionButtons(job,view.localPreparationOnly);assert.match(buttons,/data-approve=/);assert.ok(!buttons.includes('data-approve-auto'));assert.match(executionButton({...job,state:'READY'}),/disabled/);
});

test('existing scoped confirmation and ordinary application UI retain their independent capabilities',()=>{
 const value={jobs:[{id:'fixture-job',state:'DRAFT',canExecute:false,execution:{mode:'TASK_CONFIRM'},snapshot:{platform:'facebook'}}]};assert.equal(maintenancePreparationView(value,'scoped-task-confirmation'),value);assert.equal(maintenancePreparationView(value,undefined),value);assert.match(draftVersionButtons(value.jobs[0],false),/data-approve-auto/);assert.equal(draftVersionButtons({...value.jobs[0],state:'UNKNOWN'},true),'');
});
