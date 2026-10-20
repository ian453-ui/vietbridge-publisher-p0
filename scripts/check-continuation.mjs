import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {continuationReadiness} from '../src/continuation-readiness.js';

// Git calls are read-only; no remote, database, browser or platform requests.
try {
  if(process.argv.length!==3)throw Error('INPUT_FILE_REQUIRED');
  const raw=readFileSync(process.argv[2],'utf8');
  if(Buffer.byteLength(raw)>1024*1024)throw Error('INPUT_TOO_LARGE');
  const input=JSON.parse(raw);
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const source={repository:git('remote','get-url','origin'),branch:git('branch','--show-current'),commit:git('rev-parse','HEAD'),clean:git('status','--porcelain')===''};
  console.log(JSON.stringify(continuationReadiness(input,source),null,2));
} catch {
  // Do not echo supplied JSON, remote credentials, paths or child-process stderr.
  console.error('Continuation check failed: verify JSON input and run from the intended repository.');
  process.exitCode=1;
}
