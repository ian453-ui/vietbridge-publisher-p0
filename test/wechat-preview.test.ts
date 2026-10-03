import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWechatPreviewArticle } from '../src/wechat-preview.js';

test('preview renders decorated WeChat headings as semantic headings, not escaped HTML',()=>{
  const html=renderWechatPreviewArticle('## <span style="color:#1B3658">先看结论</span>\n\n正文 **关键事实**。',[],()=>'/asset');
  assert.match(html,/<h2>先看结论<\/h2>/);
  assert.match(html,/<strong>关键事实<\/strong>/);
  assert.doesNotMatch(html,/&lt;span|style=/);
});

test('legacy single-newline copy renders as readable paragraphs and preserves section labels',()=>{
  const html=renderWechatPreviewArticle('# 标题\n【事实锚点】\n第一段事实。\n【事实边界】\n第二段事实。\n- 行动一\n- 行动二',[],()=>'/asset');
  assert.match(html,/<h1>标题<\/h1>/);
  assert.match(html,/<h3 class="preview-label">事实锚点<\/h3>/);
  assert.match(html,/<p>第一段事实。<\/p>/);
  assert.match(html,/<ul><li>行动一<\/li><li>行动二<\/li><\/ul>/);
});

test('preview strips arbitrary HTML and only links allowlisted HTTP(S) URLs',()=>{
  const html=renderWechatPreviewArticle('<script>alert(1)</script> [来源](https://example.com/a) [坏链接](javascript:alert(1))',[],()=>'/asset');
  assert.doesNotMatch(html,/<script>|href="javascript:/i);
  assert.match(html,/坏链接/);
  assert.match(html,/href="https:\/\/example\.com\/a"/);
  assert.match(html,/alert\(1\)/);
});

test('inline body image references resolve to canonical frozen image bytes',()=>{
  const assets=[{filename:'body-01.png',path:'/library/body-01.png'}];
  const html=renderWechatPreviewArticle('![时间线](assets/body-01.png)',assets,()=>'/api/assets/body-01.png');
  assert.match(html,/<img src="\/api\/assets\/body-01\.png" alt="时间线">/);
});

test('a body infographic promoted to cover is not mistaken for a rendered article image',()=>{
  const assets=[{filename:'body_01_INGESTED.png',role:'cover',path:'/library/body_01_INGESTED.png'}];
  const missing=renderWechatPreviewArticle('# 标题\n\n正文没有图片。',assets,()=>'/asset');
  assert.match(missing,/正文信息图没有出现在公众号正文中/);
  const placed=renderWechatPreviewArticle('# 标题\n\n![主图](body_01_INGESTED.png)',assets,()=>'/asset');
  assert.doesNotMatch(placed,/正文信息图没有出现在公众号正文中/);
  assert.match(placed,/<img src="\/asset" alt="主图">/);
});
