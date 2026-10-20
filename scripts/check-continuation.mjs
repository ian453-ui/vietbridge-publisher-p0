import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {continuationReadiness} from '../src/continuation-readiness.js';
import {continuationReport} from '../src/continuation-report.js';

const args=process.argv.slice(2);
const help='用法：npm run check:continuation -- [--text] /绝对路径/交接证据.json\n默认输出 JSON；--text 输出中文只读诊断。输入示例及字段见 handoff/continuation-readiness.md。\n不连接 Mac，不修改 owner、数据库、代码或发布权限。';
if(args.length===1&&args[0]==='--help')console.log(help);
else {
 let failure='参数无效；使用 --help 查看用法。';
 try {
  const text=args[0]==='--text',file=text?args[1]:args[0];
  if(args.length!==(text?2:1)||!file||file.startsWith('--'))throw Error();
  failure='无法读取输入文件；确认文件存在且可读，不要提供凭据文件。';
  const raw=readFileSync(file,'utf8');
  failure='输入超过1 MiB；只提供精简交接证据。';
  if(Buffer.byteLength(raw)>1024*1024)throw Error();
  failure='JSON 格式无效；参照交接示例，错误内容不会回显。';
  const input=JSON.parse(raw);
  failure='无法读取本地 Git 身份；从原 Publisher 仓库运行，不会自动拉取。';
  const git=(...values)=>execFileSync('git',values,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const source={repository:git('remote','get-url','origin'),branch:git('branch','--show-current'),commit:git('rev-parse','HEAD'),clean:git('status','--porcelain')===''};
  failure='输入版本或结构无效；需要 version: 1 的交接证据对象。';
  const report=continuationReadiness(input,source);
  console.log(text?continuationReport(report):JSON.stringify(report,null,2));
 } catch {
  console.error('续接检查失败：'+failure);
  process.exitCode=1;
 }
}
