import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';

test('customers can be created and edited without leaking tenant data',()=>{
  const store=new Store(join(mkdtempSync(join(tmpdir(),'smo-customer-')),'db.sqlite'));
  try{
    const created=store.saveWorkspace({name:'New Customer',brand:'New Brand',project:'Training'});
    assert.match(created.id,/^ws-/);
    assert.equal(store.view(created.id).content.length,0);
    assert.equal(store.facebookView(created.id).accounts.length,0);
    const updated=store.saveWorkspace({...created,name:'Renamed Customer'});
    assert.equal(updated.id,created.id);
    assert.equal(store.view(created.id).workspaces.find(x=>x.id===created.id).name,'Renamed Customer');
    assert.equal(store.view('ws-vietbridge').workspaces.find(x=>x.id==='ws-vietbridge').name,'VietBridge');
    assert.throws(()=>store.saveWorkspace({id:'missing',name:'X',brand:'X'}),/客户不存在/);
  } finally { store.close(); }
});
