import {existsSync, realpathSync, statSync} from 'node:fs';
import {dirname, resolve, relative, isAbsolute} from 'node:path';

// Normalize public article images before committing any external request.
// Every local dependency is frozen with the content snapshot.
export function prepareWechatMedia(markdown:string, sourceFile:string, packageRoot:string):{markdown:string;paths:string[]} {
  const paths=new Set<string>();
  const root=realpathSync(packageRoot);
  const normalize=(value:string):string=>{
    const raw=value.trim().replace(/^(['"])(.*)\1$/,'$2');
    if(/^https:\/\//i.test(raw)) return raw;
    if(/^[a-z][a-z0-9+.-]*:/i.test(raw)) throw new Error('公众号图片只支持 HTTPS 或内容包内本地文件');
    const path=resolve(dirname(sourceFile),raw);
    if(!existsSync(path)||!statSync(path).isFile()) throw new Error('公众号图片文件不存在：'+raw);
    const real=realpathSync(path), rel=relative(root,real);
    if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)) throw new Error('公众号图片超出当前内容包范围');
    paths.add(real);return real;
  };
  const output=markdown.replace(/^(cover:\s*)(.+)$/m,(_,prefix,value)=>prefix+JSON.stringify(normalize(value)))
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g,(_,alt,value)=>'!['+alt+'](<'+normalize(value.replace(/^<|>$/g,''))+'>)');
  return {markdown:output,paths:[...paths]};
}
