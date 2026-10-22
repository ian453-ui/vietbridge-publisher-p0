import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cloudD1Fixture} from './sites-cloud-d1.js';
import {metricTarget} from './synthetic-metrics.js';
import {createProductionRequest,packageProductionResult,inspectProductionPackage,productionItemFingerprint} from '../../src/production-artifact-contract.js';

export async function sitesEvidenceFixture(t){
 const root=mkdtempSync(join(tmpdir(),'sites-evidence-')),path=join(root,'db.sqlite'),f=cloudD1Fixture(path);t.after(()=>{f.close();rmSync(root,{recursive:true,force:true});});
 return {root,path,f,...await seedSitesRecords(f)};
}
export async function seedSitesRecords(f){
 const post=async(path,body)=>{const r=await f.call(path,{command_id:crypto.randomUUID(),...body});if(r.status!==200)throw Error(JSON.stringify(r));return r.body;};
 const w=(await post('/api/sites/workspaces',{name:'Synthetic cloud customer'})).id,base='/api/sites/workspaces/'+w,a=(await post(base+'/accounts',{display_name:'Synthetic FB',platform:'facebook',external_identity:null})).id;
 const c=(await post(base+'/contents',{account_id:a,content_id:'SYNTHETIC-20261022-074',slug:'test-body',revision:1,title:'Synthetic body',body:'Complete synthetic article.',variants:{facebook:{title:'Synthetic platform',body:'Explicit platform copy.'}}})).id;
 const content=f.sql.prepare('SELECT * FROM sites_contents WHERE id=?').get(c),job=await post(base+'/tasks',{account_id:a,content_id:c,expected_payload_hash:content.payload_hash});
 const target={...metricTarget({workspace:w,accountId:a}),content_id:c,content_revision:job.snapshot_hash,publication_job_id:job.id};
 return {post,workspace:w,accountId:a,scope:{workspace:w,accountId:a},target,job};
}

// File-backed R2 METHOD-SHAPE fixture. No R2 account, credentials or network.
export function fileBucket(root){
 mkdirSync(root,{recursive:true});let puts=0,gets=0;const controls={getError:null,afterPutError:null};
 const file=key=>join(root,createHash('sha256').update(key).digest('hex'));
 return {controls,get puts(){return puts;},get gets(){return gets;},file,
  async put(key,data){puts++;const path=file(key),tmp=path+'.'+crypto.randomUUID();writeFileSync(tmp,Buffer.from(data));renameSync(tmp,path);if(controls.afterPutError)throw Error(controls.afterPutError);return {size:data.byteLength};},
  async get(key){gets++;if(controls.getError==='TIMEOUT')return new Promise(()=>{});if(controls.getError)throw Error(controls.getError);const path=file(key);if(!existsSync(path))return null;const data=new Uint8Array(readFileSync(path));return {size:data.length,body:new ReadableStream({start(c){c.enqueue(data);c.close();}})};}
 };
}

export function inspectedPacket(root,scope,{taskId='SYNTHETIC-SITES-REVIEW',revision=1,prior=null,video=false,platformPayload=false,platform='facebook',platformBody=null}={}){
 const dir=join(root,crypto.randomUUID());mkdirSync(dir);writeFileSync(join(dir,'body.md'),'# Synthetic full article\n\n正文结尾完整保留。');writeFileSync(join(dir,'cover.png'),readFileSync(new URL('./gpt-primary.png',import.meta.url)));
 const old=prior?.items[0],item={source_id:'SYNTHETIC-20261022-074',content_revision:revision,visual_revision:1,previous_revision:old?productionItemFingerprint(old):null,brief:'Synthetic only revision '+revision,source_refs:[],deliverables:[{artifact_id:'body',kind:'knowledge_article',language:'zh',platform:null,references:[]},{artifact_id:'cover',kind:'cover',language:'zh',platform:null,references:[]}]},now=Date.now();
 const files=[{artifact_id:'body',path:'body.md'},{artifact_id:'cover',path:'cover.png'}];if(video){execFileSync(process.env.PUBLISHER_TEST_FFMPEG_PATH||'/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x240:d=1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',join(dir,'video.mp4')],{timeout:15000});item.deliverables.push({artifact_id:'video',kind:'video',language:'zh',platform:null,references:[]});files.push({artifact_id:'video',path:'video.mp4'});}
 if(platformPayload){item.deliverables.push({artifact_id:'platform',kind:'platform_payload',language:'zh',platform,references:['body',video?'video':'cover']});writeFileSync(join(dir,'platform.md'),platform==='facebook'?(platformBody??'Synthetic explicitly approved platform copy.'):platform==='wechat_official_account'?'---\ntitle: 合成公众号草稿\nauthor: 合成作者\n---\n\n合成文章正文。':'title: 合成平台标题\nbody: 合成平台正文。\ntags: [合成验收]');files.push({artifact_id:'platform',path:'platform.md'});}
 const request=createProductionRequest({schema_version:2,mode:'PRODUCTION_ARTIFACTS',task_id:taskId,request_revision:revision,current_owner:'GPT',producer:'GPT',workspace:scope.workspace,account_id:scope.accountId,bridge_ref:{marker:'bridge-task:v1',protocol_version:'2.0',transport:'SLACK_FIRST',slack_channel_id:'C0C6PRGNGLQ',thread_ts:'1792490400.000001'},created_at:new Date(now-1000).toISOString(),deadline_at:new Date(now+3600000).toISOString(),items:[item]},{priorRequest:prior});
 const result=packageProductionResult(request,[{source_id:item.source_id,files}],{root:dir,now}),{report,snapshots}=inspectProductionPackage(request,result,{root:dir,now});
 return {request,result,report,assets:snapshots.map(a=>({source_id:a.source_id,artifact_id:a.artifact_id,mime:a.extension==='.png'?'image/png':a.extension==='.mp4'?'video/mp4':'text/plain; charset=utf-8',data:a.data}))};
}
