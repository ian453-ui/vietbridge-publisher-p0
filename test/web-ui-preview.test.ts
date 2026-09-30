import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboard } from '../src/web-ui.ts';

test('dashboard embeds the tested WeChat preview renderer as valid browser JavaScript',()=>{
  const html=renderDashboard();
  const script=html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script,'dashboard script is present');
  assert.match(script,/const articlePreviewHtml=function renderWechatPreviewArticle/);
  assert.doesNotMatch(script,/function articlePreviewHtml\(/);
  assert.doesNotThrow(()=>new vm.Script(script));
  const start=script.indexOf('const articlePreviewHtml=')+'const articlePreviewHtml='.length;
  const end=script.indexOf('\n};',start);
  assert.ok(end>start,'serialized preview renderer is bounded in the dashboard script');
  const serialized=script.slice(start,end+2).trim();
  const render=vm.runInNewContext('('+serialized+')');
  const preview=render('## <span style="color:#1B3658">结论</span>\n\n正文。',[],()=>'/asset');
  assert.match(preview,/<h2>结论<\/h2>/);
  assert.match(preview,/<p>正文。<\/p>/);
});
