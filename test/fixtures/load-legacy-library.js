import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,symlinkSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
/** Exact dfba522 library/index/publisher/executor; unchanged dependencies reused. */
export async function loadLegacyLibrary(){
 const root=mkdtempSync(join(tmpdir(),'dfba522-code-')),repo=fileURLToPath(new URL('../..',import.meta.url));mkdirSync(join(root,'src','publisher-core'),{recursive:true});writeFileSync(join(root,'package.json'),'{"type":"module"}');symlinkSync(join(repo,'node_modules'),join(root,'node_modules'));
 const frozen=['library.js','unified-publisher.js','unified-executor.js'];for(const name of readdirSync(join(repo,'src')))if(!frozen.includes(name)&&name!=='publisher-core')symlinkSync(join(repo,'src',name),join(root,'src',name));
 for(const name of readdirSync(join(repo,'src','publisher-core')))if(name!=='content-library.ts')symlinkSync(join(repo,'src','publisher-core',name),join(root,'src','publisher-core',name));
 for(const name of frozen)copyFileSync(fileURLToPath(new URL('./dfba522-'+name+'.txt',import.meta.url)),join(root,'src',name));copyFileSync(fileURLToPath(new URL('./dfba522-content-library.ts.txt',import.meta.url)),join(root,'src','publisher-core','content-library.ts'));
 const load=name=>import(pathToFileURL(join(root,'src',name)).href);const [library,publisher,executor]=await Promise.all(frozen.map(load));return {LegacyGroupLibrary:library.GroupLibrary,LegacyPublisher:publisher.UnifiedPublisher,LegacyExecutor:executor.UnifiedExecutor,close:()=>rmSync(root,{recursive:true,force:true})};
}
