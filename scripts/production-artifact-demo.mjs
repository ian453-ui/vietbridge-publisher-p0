import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createProductionRequest,packageProductionResult,inspectProductionResult} from '../src/production-artifact-contract.js';
const save=(path,value)=>writeFileSync(path,value,{flag:'wx'}),json=x=>JSON.stringify(x,null,2)+'\n';
export function productionDemo(out){
 mkdirSync(out);const root=join(out,'artifacts');mkdirSync(root);const image=readFileSync(new URL('../test/fixtures/gpt-primary.png',import.meta.url));
 const spec=(artifact_id,kind,references=[],platform=null)=>({artifact_id,kind,language:'vi+zh',platform,references});
 const item=(source_id,deliverables)=>({source_id,content_revision:1,visual_revision:1,previous_revision:null,brief:'Synthetic production only; not Study task output.',source_refs:[],deliverables});
 const items=['SYNTHETIC-KB-003','SYNTHETIC-KB-040'].map(source_id=>item(source_id,[spec('article','knowledge_article'),spec('cover','cover'),spec('facebook','platform_payload',['article','cover'],'facebook')]));
 items.push(item('SYNTHETIC-VIDEO-001',[spec('script','script'),spec('subtitle','subtitle',['script']),spec('video','video',['script','subtitle']),spec('cover','cover',['video'])]));
 for(const source of items.slice(0,2)){mkdirSync(join(root,source.source_id));save(join(root,source.source_id,'article.md'),'# Synthetic '+source.source_id+'\n\nNội dung thử nghiệm.\n\n合成知识稿，不是实际 Study 交付。\n');save(join(root,source.source_id,'cover.png'),image);save(join(root,source.source_id,'facebook.txt'),'Synthetic independent Facebook copy for '+source.source_id);}
 mkdirSync(join(root,'SYNTHETIC-VIDEO-001'));save(join(root,'SYNTHETIC-VIDEO-001/script.md'),'# Synthetic script\n\nShow a blue frame for one second.\n');save(join(root,'SYNTHETIC-VIDEO-001/subtitle.srt'),'1\n00:00:00,000 --> 00:00:01,000\nSynthetic subtitle\n');save(join(root,'SYNTHETIC-VIDEO-001/cover.png'),image);
 execFileSync(process.env.PUBLISHER_TEST_FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x240:d=1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',join(root,'SYNTHETIC-VIDEO-001/video.mp4')],{timeout:15000,stdio:['ignore','pipe','pipe']});
 const now=Date.now(),plan={schema_version:2,mode:'PRODUCTION_ARTIFACTS',task_id:'SYNTHETIC-MULTI-CONTENT-DEMO',request_revision:1,current_owner:'GPT',producer:'GPT',workspace:null,account_id:null,bridge_ref:{marker:'bridge-task:v1',protocol_version:'2.0',transport:'SLACK_FIRST',slack_channel_id:'C0C6PRGNGLQ',thread_ts:'1792490400.000001'},created_at:new Date(now-1000).toISOString(),deadline_at:new Date(now+3600000).toISOString(),items};
 const names={article:'article.md',cover:'cover.png',facebook:'facebook.txt',script:'script.md',subtitle:'subtitle.srt',video:'video.mp4'};
 const selections=items.map(item=>({source_id:item.source_id,files:item.deliverables.map(d=>({artifact_id:d.artifact_id,path:item.source_id+'/'+names[d.artifact_id]}))}));
 const request=createProductionRequest(plan),result=packageProductionResult(request,selections,{root,now}),report=inspectProductionResult(request,result,{root,now});
 for(const [name,value] of Object.entries({plan,selections,request,result,report}))save(join(out,name+'.json'),json(value));
 return {status:report.status,structure:report.structure,scope_status:report.scope_status,items:report.items.map(x=>({source_id:x.source_id,artifacts:x.artifacts.map(a=>({kind:a.kind,validation:a.validation}))})),publish_allowed:false,import_allowed:false,synthetic_only:true,sent:false};
}
