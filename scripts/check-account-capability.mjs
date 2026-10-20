import {readFileSync,statSync} from 'node:fs';
import {parseStrictJson} from '../src/strict-json.js';
import {diagnoseAccountCapability} from '../src/account-capability-facts.js';
try{
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--help')console.log('用法：node scripts/check-account-capability.mjs EVIDENCE.json\n只读账号动作能力诊断；不联网、不授权、不发布。字段见 handoff/account-capability-facts.md。');
 else{
  if(args.length!==1||!statSync(args[0]).isFile()||statSync(args[0]).size>1024*1024)throw Error('INVALID_FILE');
  console.log(JSON.stringify(diagnoseAccountCapability(parseStrictJson(readFileSync(args[0],'utf8'))),null,2));
 }
}catch(error){console.error('Capability evidence rejected: '+(/^[A-Z_]{3,80}$/.test(error.message)?error.message:'INVALID_FILE_OR_JSON'));process.exitCode=1;}
