import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {hasExplicitRepublishEvidence,isWechatIpWhitelistRejection,PlatformWorker,prepareWechatDraftMarkdown} from '../src/platform-worker.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/database.ts';
import {PublisherStore} from '../src/publisher-store.ts';

function metadata(markdown:string):Record<string,unknown>{
  const match=markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match);
  return parse(match[1]);
}

test('plain public copy gets Wenyan title, author and frozen cover metadata',()=>{
  const input='越南进口增速35.3%：采购增长前先做暴露图\n\n正文第一段。';
  const output=prepareWechatDraftMarkdown(input,'正式标题',[{role:'cover',staging_path:'/frozen/cover.png',mime_detected:'image/png'}]);
  assert.deepEqual(metadata(output),{title:'正式标题',author:'驻越经营实录',cover:'/frozen/cover.png'});
  assert.match(output,/正文第一段。/);
});

test('public article title is not repeated as the first body paragraph',()=>{
  const output=prepareWechatDraftMarkdown('正式标题\n\n文章导语。','正式标题',[{role:'cover',staging_path:'/frozen/cover.png',mime_detected:'image/png'}]);
  assert.equal((output.match(/正式标题/g)||[]).length,1);
  assert.match(output,/文章导语。/);
});

test('existing public frontmatter is preserved and only missing required fields are filled',()=>{
  const input='---\ntitle: 自带标题\nauthor: 自带作者\ndigest: 摘要\n---\n正文。';
  const output=prepareWechatDraftMarkdown(input,'备用标题',[{role:'cover',staging_path:'/frozen/cover.png',mime_detected:'image/png'}]);
  assert.deepEqual(metadata(output),{title:'自带标题',author:'自带作者',digest:'摘要',cover:'/frozen/cover.png'});
  assert.equal((output.match(/^---$/gm)||[]).length,2);
});

test('missing cover fails before connector submission',()=>{
  assert.throws(()=>prepareWechatDraftMarkdown('正文','标题',[]),/缺少封面/);
});

test('canonical body images are appended in sequence when the article has no placement markers',()=>{
  const output=prepareWechatDraftMarkdown('正文。','标题',[
    {role:'gallery_image',sequence:2,staging_path:'/frozen/body-02.png',filename:'body-02.png',mime_detected:'image/png'},
    {role:'cover',sequence:0,staging_path:'/frozen/cover.png',filename:'cover.png',mime_detected:'image/png'},
    {role:'gallery_image',sequence:1,staging_path:'/frozen/body-01.png',filename:'body-01.png',mime_detected:'image/png'}
  ]);
  assert.ok(output.indexOf('/frozen/body-01.png')<output.indexOf('/frozen/body-02.png'));
  assert.equal((output.match(/!\[正文图片/g)||[]).length,2);
});

test('legacy body images are interleaved through single-newline public copy instead of detached at the end',()=>{
  const output=prepareWechatDraftMarkdown(
    '# 标题\n\n导语。\n事实一。\n事实二。\n经营分析。\n风险边界。\n行动清单。\n结尾。',
    '标题',
    [
      {role:'cover',sequence:0,staging_path:'/frozen/cover.png',filename:'cover.png',mime_detected:'image/png'},
      {role:'gallery_image',sequence:1,staging_path:'/frozen/body-01.png',filename:'body-01.png',mime_detected:'image/png'},
      {role:'gallery_image',sequence:2,staging_path:'/frozen/body-02.png',filename:'body-02.png',mime_detected:'image/png'}
    ]
  );
  const first=output.indexOf('/frozen/body-01.png'),second=output.indexOf('/frozen/body-02.png');
  assert.ok(output.indexOf('事实一。')<first);
  assert.ok(first<output.indexOf('行动清单。'));
  assert.ok(output.indexOf('经营分析。')<second);
  assert.ok(second<output.indexOf('结尾。'));
  assert.ok(output.lastIndexOf('/frozen/body-01.png')<output.lastIndexOf('结尾。'));
});

test('relative inline image references resolve to frozen assets without appending duplicates',()=>{
  const output=prepareWechatDraftMarkdown(
    '# 标题\n\n第一段。\n\n![管理决策队列](assets/body-01.png)\n\n第二段。',
    '标题',
    [
      {role:'cover',sequence:0,staging_path:'/frozen/cover.png',filename:'cover.png',mime_detected:'image/png'},
      {role:'gallery_image',sequence:1,staging_path:'/frozen/body-01.png',filename:'body-01.png',mime_detected:'image/png'}
    ]
  );
  assert.match(output,/!\[管理决策队列\]\(<\/frozen\/body-01\.png>\)/);
  assert.equal((output.match(/body-01\.png/g)||[]).length,1);
  assert.ok(output.indexOf('第一段。')<output.indexOf('body-01.png'));
  assert.ok(output.indexOf('body-01.png')<output.indexOf('第二段。'));
});

test('a cover reused by the authored body resolves to the frozen asset path',()=>{
  const output=prepareWechatDraftMarkdown(
    '# 标题\n\n![视觉摘要](body_01_INGESTED.png)\n\n正文。',
    '标题',
    [
      {role:'cover',sequence:0,staging_path:'/frozen/body_01_INGESTED.png',filename:'body_01_INGESTED.png',mime_detected:'image/png'}
    ]
  );
  assert.match(output,/cover: \/frozen\/body_01_INGESTED\.png/);
  assert.match(output,/!\[视觉摘要\]\(<\/frozen\/body_01_INGESTED\.png>\)/);
  assert.equal((output.match(/body_01_INGESTED\.png/g)||[]).length,2);
});

test('legacy body infographic placeholder is removed and replaced by canonical image',()=>{
  const output=prepareWechatDraftMarkdown('正文。\n\n【正文高密度信息图】','标题',[
    {role:'cover',sequence:0,staging_path:'/frozen/cover.png',mime_detected:'image/png'},
    {role:'gallery_image',sequence:1,staging_path:'/frozen/body-01.png',filename:'body-01.png',mime_detected:'image/png'}
  ]);
  assert.doesNotMatch(output,/正文高密度信息图/);
  assert.match(output,/!\[正文图片 01\]\(<\/frozen\/body-01\.png>\)/);
});

test('frozen WeChat assembly removes internal asset manifest lines before readback',()=>{
  const markdown=prepareWechatDraftMarkdown('# 标题\n\n正文。\n\n【VISUAL_ASSET_MANIFEST｜内部字段】\nactive_assets: cover_QA_PASS.png','标题',[{role:'cover',staging_path:'/frozen/cover.png',mime_detected:'image/png'}]);
  assert.doesNotMatch(markdown,/VISUAL_ASSET_MANIFEST|active_assets:/);
  assert.match(markdown,/正文。/);
});

test('numbered editorial subheadings become real Markdown headings without changing article claims',()=>{
  const source='# 标题\n\n导语。\n\n一、先看时间线：2026 年不是一天换完\n\n第 5 条｜投资经营政策\n\n第 7 条还明确，条件需要持续满足。\n\n第一类：业务已经产生收入\n\n结论。';
  const output=prepareWechatDraftMarkdown(source,'标题',[{role:'cover',staging_path:'/frozen/cover.png',mime_detected:'image/png'}]);
  assert.match(output,/^## <span style="color:#1B3658">一、先看时间线：2026 年不是一天换完<\/span>$/m);
  assert.match(output,/^### <span style="color:#1B3658">第 5 条｜投资经营政策<\/span>$/m);
  assert.match(output,/^### <span style="color:#1B3658">第一类：业务已经产生收入<\/span>$/m);
  assert.match(output,/^第 7 条还明确，条件需要持续满足。$/m);
  assert.equal((output.match(/^# <span style="color:#1B3658">标题<\/span>$/gm)||[]).length,0);
});

test('explicit safe WeChat heading color overrides brand fallback without leaking frontmatter',()=>{
  const output=prepareWechatDraftMarkdown('---\nheading_color: "#AA3322"\n---\n# 标题\n\n## 小标题\n\n正文。','标题',[{role:'cover',staging_path:'/frozen/cover.png',mime_detected:'image/png'}]);
  assert.match(output,/^## <span style="color:#AA3322">小标题<\/span>$/m);
  assert.doesNotMatch(output,/heading_color:/);
  assert.throws(()=>prepareWechatDraftMarkdown('---\nheading_color: "red;position:absolute"\n---\n# 标题','标题',[{role:'cover',staging_path:'/frozen/cover.png',mime_detected:'image/png'}]),/标题颜色/);
});

test('explicit republish evidence bypasses only historical duplicate protection',()=>{
  assert.equal(hasExplicitRepublishEvidence([{evidence_json:'{"republish":true}'}]),true);
  assert.equal(hasExplicitRepublishEvidence([{evidence_json:'{"republish":false}'},{evidence_json:'not-json'}]),false);
});

test('explicit WeChat IP whitelist rejection clears an ambiguous draft without re-uploading',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wechat-whitelist-reconcile-'));
  try{
    const db=openDatabase(join(root,'db.sqlite')),store=new PublisherStore(db),jobId=store.createJob({articleId:'VBE-20260923-072',platform:'wechat_official_account',accountId:'wechat',packageHash:'hash'});
    db.prepare("UPDATE jobs SET state='RECONCILE_PENDING',submit_safety_domain='MAY_HAVE_SUBMITTED' WHERE job_id=?").run(jobId);
    db.prepare('INSERT INTO state_transitions(job_id,from_state,to_state,event_id,evidence_json,created_at) VALUES(?,?,?,?,?,?)').run(jobId,'SUBMITTED_PENDING_CONFIRMATION','UNKNOWN','ip-error',JSON.stringify({error:'WeChat draft response ambiguous: 执行工具失败: 40164: invalid ip 116.108.255.145, not in whitelist'}),'2026-09-24T00:39:25Z');
    const result=await new PlatformWorker(db).reconcileWechatDraft(jobId) as {requiresWhitelist?:boolean};
    assert.equal(result.requiresWhitelist,true);
    assert.equal(store.getJob(jobId).state,'FAILED');
    assert.equal(store.getJob(jobId).submit_safety_domain,'BEFORE_EXTERNAL_SUBMIT');
    assert.equal(isWechatIpWhitelistRejection('network timeout'),false);
    db.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
