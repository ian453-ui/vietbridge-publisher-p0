import assert from 'node:assert/strict';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {reopenFixture} from './helpers/browser-reopen-fixture.js';
import {chromeProcessConflicts} from '../src/browser-profile-reopen.js';

const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const failures=[];
for(const kind of ['case-alias','port-only','official-command-only','no-directory-blank']){
 const cleanup=[],f=reopenFixture({after:fn=>cleanup.push(fn)}),before=f.snapshot();
 try{
  const alias=f.profile.user_data_dir.replace(/chrome$/,'CHROME');
  const command=kind==='case-alias'?CHROME+' --remote-debugging-port=17922 --user-data-dir='+alias+' about:blank':kind==='port-only'?CHROME+' --remote-debugging-port=17922 about:blank':kind==='official-command-only'?CHROME:CHROME+' about:blank';
  const existing={pid:88,command};let helperConflict,helperError;
  try{helperConflict=chromeProcessConflicts(existing,f.authorization.scope);}catch(e){helperError=e.message;}
  // Keep the existing mock process visible after launch; never hide a conflict to manufacture success.
  const r=f.instance({processState:async scope=>{const live=await f.hooks.processState(scope);return {...live,chrome:[existing,...live.chrome]};}});
  let result,error;try{result=await r.start(f.w.id,f.job.id,f.input());}catch(e){error=e.message;}
  const evidence={kind,helperConflict,helperError,mockStartupCount:f.launches,markerConsumed:existsSync(r.marker),readbackPresent:existsSync(join(f.owner,'../readback')),result:result?.stage,error,originalLeaseEqual:readFileSync(f.owner).equals(f.lease),historyEqual:JSON.stringify(f.snapshot())===JSON.stringify(before),realProfileLaunch:false};
  if(kind==='case-alias'){
   const a=statSync(alias,{bigint:true}),b=statSync(f.profile.user_data_dir,{bigint:true});
   evidence.samePhysicalDirectoryByDeviceAndInode=a.dev===b.dev&&a.ino===b.ino;
   evidence.realpathStringEqual=realpathSync(alias)===realpathSync(f.profile.user_data_dir);
  }else evidence.existingChromeDirectoryUnverifiable=true;
  console.log(JSON.stringify(evidence));
  assert.equal(f.launches,0,kind+': reject before mock spawn');
  assert.equal(evidence.markerConsumed,false);assert.equal(evidence.readbackPresent,false);
  assert.equal(evidence.originalLeaseEqual,true);assert.equal(evidence.historyEqual,true);
  assert.equal(error,kind==='case-alias'?'BROWSER_REOPEN_PROCESS_CONFLICT':'BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED');
  if(kind==='case-alias'){assert.equal(evidence.samePhysicalDirectoryByDeviceAndInode,true);assert.equal(evidence.realpathStringEqual,false);assert.equal(helperConflict,true);}
  else assert.equal(helperError,'BROWSER_REOPEN_PROCESS_PATH_UNVERIFIED');
 }catch(e){failures.push(kind+': '+e.message);}finally{for(const fn of cleanup)fn();}
}
assert.deepEqual(failures,[],'All exact isolated counterexamples must block before marker/readback/spawn');
