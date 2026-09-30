import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyWechatDraft} from '../src/wechat-draft-reader.ts';
test('WeChat completion requires title, author, cover and body readback',()=>{
 const markdown='---\ntitle: 公开标题\nauthor: 驻越经营实录\n---\n第一段。\n\n第二段。';
 const item={title:'公开标题',author:'驻越经营实录',thumb_media_id:'cover-id',content:'<p>第一段。</p><p>第二段。</p>'};
 assert.equal(verifyWechatDraft(markdown,{news_item:[item]}),true);
 assert.equal(verifyWechatDraft(markdown,{news_item:[{...item,thumb_media_id:'',thumb_url:'https://mmbiz.qpic.cn/cover'}]}),true);
 for(const patch of [{title:'其他标题'},{author:'其他账号'},{thumb_media_id:''},{content:'第一段。'}]) assert.equal(verifyWechatDraft(markdown,{news_item:[{...item,...patch}]}),false);
 assert.equal(verifyWechatDraft(markdown,{news_item:[item,item]}),false);
});
test('WeChat readback accepts rendered list markers and table cells without weakening text checks',()=>{
 const markdown='---\ntitle: 标题\nauthor: 作者\n---\n1. 第一项内容\n2. 第二项内容\n\n| 项目 | 结论 |\n| --- | --- |\n| 市场 | 已进入 |';
 const base={title:'标题',author:'作者',thumb_media_id:'cover',content:'<ol><li>第一项内容</li><li>第二项内容</li></ol><table><tr><th>项目</th><th>结论</th></tr><tr><td>市场</td><td>已进入</td></tr></table>'};
 assert.equal(verifyWechatDraft(markdown,{news_item:[base]}),true);
 assert.equal(verifyWechatDraft(markdown,{news_item:[{...base,content:base.content.replace('第二项内容','其他内容')}]}),false);
});
test('WeChat draft readback rejects lost subheading hierarchy even when all text survives',()=>{
 const markdown='---\ntitle: 标题\nauthor: 作者\n---\n导语。\n\n## 一、经营边界\n\n正文。\n\n### 第 5 条｜投资经营政策\n\n说明。';
 const base={title:'标题',author:'作者',thumb_media_id:'cover',content:'<p>导语。</p><h2>一、经营边界</h2><p>正文。</p><h3>第 5 条｜投资经营政策</h3><p>说明。</p>'};
 assert.equal(verifyWechatDraft(markdown,{news_item:[base]}),true);
 assert.equal(verifyWechatDraft(markdown,{news_item:[{...base,content:base.content.replace('<h2>一、经营边界</h2>','<p>一、经营边界</p>')}]}),false);
 assert.equal(verifyWechatDraft(markdown,{news_item:[{...base,content:base.content.replace('<h3>第 5 条｜投资经营政策</h3>','<h2>第 5 条｜投资经营政策</h2>')}]}),false);
});
test('WeChat draft readback rejects a stripped heading color',()=>{
 const markdown='---\ntitle: 标题\nauthor: 作者\n---\n# 标题\n\n## <span style="color:#1B3658">一、经营边界</span>\n\n正文。';
 const base={title:'标题',author:'作者',thumb_media_id:'cover',content:'<h1>标题</h1><h2><span style="color: rgb(27, 54, 88)">一、经营边界</span></h2><p>正文。</p>'};
 assert.equal(verifyWechatDraft(markdown,{news_item:[base]}),true);
 assert.equal(verifyWechatDraft(markdown,{news_item:[{...base,content:base.content.replace(' style="color: rgb(27, 54, 88)"','')}]}),false);
});
test('WeChat source links tolerate renderer footnote numbers but not missing source text',()=>{
 const markdown='---\ntitle: 标题\nauthor: 作者\n---\n资料来源：[官方公告](https://example.com/a)；[年度报告](https://example.com/b)。结论须区分。';
 const base={title:'标题',author:'作者',thumb_media_id:'cover',content:'<p>资料来源：官方公告<sup class="footnote" style="color: blue">[1]</sup>；年度报告<sup class="footnote">[2]</sup>。结论须区分。</p><h3>引用链接</h3>'};
 assert.equal(verifyWechatDraft(markdown,{news_item:[base]}),true);
 assert.equal(verifyWechatDraft(markdown,{news_item:[{...base,content:base.content.replace('年度报告','其他来源')}]}),false);
});
