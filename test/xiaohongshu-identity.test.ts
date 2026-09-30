import test from 'node:test';
import assert from 'node:assert/strict';
import {xiaohongshuIdentityError} from '../src/platform-worker.ts';

test('Xiaohongshu login, unverified identity and actual mismatch remain distinct',()=>{
  const expected='username:Vietbridge 越南商学院';
  assert.equal(xiaohongshuIdentityError({loggedIn:false},expected),'XHS_LOGIN_REQUIRED');
  assert.equal(xiaohongshuIdentityError({loggedIn:true},expected),'XHS_ACCOUNT_UNVERIFIED');
  assert.equal(xiaohongshuIdentityError({loggedIn:true,accountId:'username:其他账号'},expected),'XHS_ACCOUNT_MISMATCH');
  assert.equal(xiaohongshuIdentityError({loggedIn:true,accountId:expected},expected),undefined);
});
