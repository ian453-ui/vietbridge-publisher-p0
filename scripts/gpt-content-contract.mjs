import {parseStrictJson} from '../src/strict-json.js';
import {readFileSync,statSync} from 'node:fs';
import {createGptContentRequest,inspectGptContentResult} from '../src/gpt-content-contract.js';
const args=process.argv.slice(2);
const help='本地内容契约（不发送、不领取、不批准、不发布）\nrequest INPUT.json [PRIOR_REQUEST.json]\ninspect REQUEST.json RESULT.json [PRIOR_RECEIPT.json]\n输出至 stdout；只使用明确授权的内容元数据，不输入凭据。参见 handoff/gpt-content-contract.md。';
function read(path){if(!statSync(path).isFile()||statSync(path).size>1024*1024)throw Error('INVALID_FILE');return parseStrictJson(readFileSync(path,'utf8'));}
try{
 if(args.length===1&&args[0]==='--help')console.log(help);
 else if(args[0]==='request'&&[2,3].includes(args.length))console.log(JSON.stringify(createGptContentRequest(read(args[1]),{priorRequest:args[2]?read(args[2]):null}),null,2));
 else if(args[0]==='inspect'&&[3,4].includes(args.length))console.log(JSON.stringify(inspectGptContentResult(read(args[1]),read(args[2]),{priorReceipt:args[3]?read(args[3]):null}),null,2));
 else throw Error('INVALID_ARGUMENTS');
}catch(error){
 const code=/^[A-Z_]{3,80}$/.test(error.message)?error.message:'INVALID_FILE_OR_JSON';
 console.error('Content contract rejected: '+code);process.exitCode=1;
}
