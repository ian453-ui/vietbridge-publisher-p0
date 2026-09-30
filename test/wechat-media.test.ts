import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareWechatMedia} from '../src/wechat-media.ts';
import {canTransition} from '../src/states.ts';
import {parseXhs,channelsDescription,completeXhsTags} from '../src/platform-worker.ts';
import {facebookToolError} from '../src/facebook-mcp-connector.ts';

test('Facebook MCP timeout is classified as temporary unavailability',()=>{
 assert.match(facebookToolError({text:'❌ fb_publish_photos 失败: timeout of 60000ms exceeded',isError:true}),/^FACEBOOK_TEMPORARILY_UNAVAILABLE:/);
});

test('Channels preserves full approved body and topics without silent truncation',()=>{
 const input='标题：测试\n第一行\n第二行\n第三行\n第四行：适用边界\n#越南投资 #越南厂房';
 const result=channelsDescription(input);
 assert.match(result,/第四行：适用边界/);
 assert.match(result,/#越南投资 #越南厂房/);
 assert.throws(()=>channelsDescription('标题\n没有话题'),/缺少相关话题/);
 assert.throws(()=>channelsDescription('标题\n'+'字'.repeat(601)+'\n#越南投资'),/未自动截断/);
});

test('XHS structured public file keeps configuration out of public body',()=>{
 const parsed=parseXhs('title: 标题\nvisibility: 公开可见\nproducts: []\ntags:\n  - 越南投资\n\ncontent:\n公开正文');
 assert.equal(parsed.body,'公开正文');
 assert.equal(parsed.tags[0],'越南投资');
});

test('XHS body/tags sections never leak internal labels or bullet tags',()=>{
 const parsed=parseXhs('title: 越南利润汇出\nbody:\n越南公司利润汇出前要核对税务和现金。\n\ntags:\n- 驻越经营实录\n- 越南投资');
 assert.equal(parsed.body,'越南公司利润汇出前要核对税务和现金。');
 assert.ok(!/body:|tags:|^- /m.test(parsed.body));
 assert.deepEqual(parsed.tags.slice(0,2),['驻越经营实录','越南投资']);
 assert.ok(parsed.tags.includes('越南税务'));
 assert.throws(()=>parseXhs('标题\n正文\nbody: 不应公开\n#越南'),/内部字段/);
});

test('XHS tag completion preserves supplied tags and only adds evidenced topics',()=>{
 const tags=completeXhsTags('越南电商平台上线前要核验中国品牌资料。',['驻越经营实录']);
 assert.equal(tags[0],'驻越经营实录');
 assert.ok(tags.includes('越南电商'));
 assert.ok(tags.includes('中国企业出海'));
 assert.ok(!tags.includes('越南用工'));
});

test('WeChat relative cover is resolved and frozen; missing images fail before submission',()=>{
 const root=mkdtempSync(join(tmpdir(),'wechat-media-'));
 try {
  mkdirSync(join(root,'public'));mkdirSync(join(root,'review'));
  const img=join(root,'review','cover.jpg');writeFileSync(img,'image');
  const result=prepareWechatMedia('---\ncover: ../review/cover.jpg\n---\n正文',join(root,'public','article.md'),root);
  assert.deepEqual(result.paths,[realpathSync(img)]);
  assert.ok(result.markdown.includes(realpathSync(img)));
  assert.throws(()=>prepareWechatMedia('cover: missing.jpg',join(root,'public','article.md'),root),/不存在/);
  assert.equal(canTransition('PLATFORM_PREFLIGHT','BLOCKED_CAPABILITY'),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
