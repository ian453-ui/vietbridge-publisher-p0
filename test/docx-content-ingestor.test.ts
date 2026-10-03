import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestDocxContentBundle,readDocxSourceReview } from "../src/docx-content-ingestor.ts";
import { ContentLibrary } from "../src/content-library.ts";

test("source review keeps metadata after an inline image inside the field block",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-source-fields-"));
  try{
    const unpacked=join(root,"docx"),word=join(unpacked,"word");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(join(word,"media"));
    const values=["VBE-20260928-089｜案例","content_id: VBE-20260928-089","status: CONTENT_VISUAL_QA_PASS","publisher_status: BLOCKED_PENDING_QA","【微信公众号母稿】","正文"];
    const paragraphs=values.map((value,index)=>`<w:p><w:r><w:t>${value}</w:t>${index===1?'<w:drawing><a:blip r:embed="rId1"/></w:drawing>':''}</w:r></w:p>`).join('');
    writeFileSync(join(word,"document.xml"),`<w:document>${paragraphs}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');
    writeFileSync(join(word,"media","image1.png"),"image");
    const docx=join(root,"bundle.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});
    const review=readDocxSourceReview(docx,"VBE-20260928-089");
    assert.equal(review.fields.publisher_status,"BLOCKED_PENDING_QA",JSON.stringify({fields:review.fields,paragraphs:review.paragraphs}));
    assert.equal(review.images.length,1);
    assert.equal(review.publicSections.wechat,true);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("GPT main article images and headings survive a plain-text WeChat adaptation",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-gpt-compatible-"));
  try{
    const word=join(root,"bundle","word"),media=join(word,"media");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(media);
    const rows:[string,string][]=[
      ["VBE-20260928-101｜案例", ""],["title: 能源项目", ""],["## 能源项目", ""],["", "rId1"],["", "rId2"],
      ["第一段关于能源项目的正式内容。", ""],["## 项目制生意", ""],["第二段关于项目采购的正式内容。", ""],
      ["【微信公众号母稿】", ""],["能源项目", ""],["第一段关于能源项目的正式内容。", ""],["项目制生意", ""],["第二段关于项目采购的正式内容。", ""],["【Facebook】", ""],["Facebook 版本", ""]
    ];
    const xml=rows.map(([value,rid])=>`<w:p><w:r>${value?`<w:t>${value}</w:t>`:""}${rid?`<w:drawing><a:blip r:embed="${rid}"/></w:drawing>`:""}</w:r></w:p>`).join("");
    writeFileSync(join(word,"document.xml"),`<w:document>${xml}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/one.png"/><Relationship Id="rId2" Target="media/two.png"/></Relationships>');
    writeFileSync(join(media,"one.png"),"first");writeFileSync(join(media,"two.png"),"second");
    const docx=join(root,"source.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:join(root,"bundle")});
    const result=ingestDocxContentBundle(docx,join(root,"content")),wechat=readFileSync(join(result.imported[0].target,"VBE-20260928-101-wechat-public.md"),"utf8");
    assert.equal((wechat.match(/!\[[^\]]*\]\(body_\d+_INGESTED\.png\)/gu)||[]).length,2);
    assert.match(wechat,/## 项目制生意/);assert.doesNotMatch(wechat,/Facebook 版本/);
    assert.equal((wechat.match(/^# 能源项目$/gmu)||[]).length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("正文建议直接使用主文 resolves the authored article instead of publishing the instruction",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-main-reference-"));
  try{
    const word=join(root,"bundle","word"),media=join(word,"media");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(media);
    const rows:[string,string][]=[["VBE-20260929-102｜主文",""],["title: 供应链本地化",""],["# 供应链本地化",""],["主文第一段。",""],["","rId1"],["## 判断重点",""],["主文详细事实。",""],["【事实核查】",""],["内部证据，不得公开。",""],["【微信公众号母稿】",""],["标题：供应链本地化",""],["导语：概要。",""],["正文建议直接使用主文。",""],["结尾CTA：检查供应链。",""]];
    const xml=rows.map(([value,rid])=>`<w:p><w:r>${value?`<w:t>${value}</w:t>`:""}${rid?`<w:drawing><a:blip r:embed="${rid}"/></w:drawing>`:""}</w:r></w:p>`).join("");
    writeFileSync(join(word,"document.xml"),`<w:document>${xml}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/one.png"/></Relationships>');writeFileSync(join(media,"one.png"),"image");
    const docx=join(root,"source.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:join(root,"bundle")});
    const result=ingestDocxContentBundle(docx,join(root,"content")),wechat=readFileSync(join(result.imported[0].target,"VBE-20260929-102-wechat-public.md"),"utf8");
    assert.match(wechat,/主文详细事实/);assert.match(wechat,/## 判断重点/);assert.match(wechat,/!\[[^\]]*\]\(body_01_INGESTED\.png\)/u);assert.match(wechat,/检查供应链/);
    assert.doesNotMatch(wechat,/正文建议直接使用主文|内部证据/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("WeChat public BEGIN/END section excludes internal mother draft and preserves images",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-public-bounds-"));
  try{
    const unpacked=join(root,"docx"),word=join(unpacked,"word");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(join(word,"media"));
    const values=["VBE-20260928-089｜案例","content_id: VBE-20260928-089","title: 公开标题","【内部母稿 BEGIN｜不是公开载荷】","内部研究笔记不得公开","【内部母稿 END】","【微信公众号公开版 BEGIN】","公众号公开正文","【微信公众号公开版 END】","【Facebook版本】","Facebook 独立文案"];
    const paragraphs=values.map((value,index)=>`<w:p><w:r><w:t>${value}</w:t>${index===7?'<w:drawing><a:blip r:embed="rId1"/></w:drawing>':''}</w:r></w:p>`).join('');
    writeFileSync(join(word,"document.xml"),`<w:document>${paragraphs}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');
    writeFileSync(join(word,"media","image1.png"),"image");
    const docx=join(root,"bundle.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});
    const review=readDocxSourceReview(docx,"VBE-20260928-089");
    assert.equal(review.publicSections.wechat,true);
    assert.match(review.publicCopies.wechat,/公众号公开正文/);
    assert.doesNotMatch(review.publicCopies.wechat,/内部研究笔记|Facebook 独立文案|微信公众号公开版 END/);
    assert.equal(review.images.length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("DOCX text and inline sibling images materialize as one idempotent ContentItem", () => {
  const root = mkdtempSync(join(tmpdir(), "docx-ingest-"));
  try {
    const unpacked = join(root, "docx"), word = join(unpacked, "word");
    mkdirSync(join(word, "_rels"), { recursive: true }); mkdirSync(join(word, "media"));
    const paragraphs = [
      "VBE-20260920-050｜融资故事不是PPT，是5张经营表", "【头图｜COVER_QA_PASS】", "", "【微信公众号母稿】", "公众号正文", "【Facebook】", "FB正文", "【LinkedIn】", "LI正文", "【小红书】", "小红书正文", "【SEO】", "内部"
    ].map((text, index) => `<w:p><w:r><w:t>${text}</w:t>${index === 1 ? '<w:drawing><a:blip r:embed="rId1"/></w:drawing>' : index === 4 ? '<w:drawing><a:blip r:embed="rId2"/></w:drawing>' : ""}</w:r></w:p>`).join("");
    writeFileSync(join(word, "document.xml"), `<w:document>${paragraphs}</w:document>`);
    writeFileSync(join(word, "_rels", "document.xml.rels"), '<Relationships><Relationship Id="rId1" Target="media/image1.png"/><Relationship Id="rId2" Target="media/image2.png"/></Relationships>');
    writeFileSync(join(word, "media", "image1.png"), "cover"); writeFileSync(join(word, "media", "image2.png"), "body");
    const docx = join(root, "bundle.docx"); execFileSync("zip", ["-q", "-r", docx, "word"], { cwd: unpacked });
    const target = join(root, "content");
    const first = ingestDocxContentBundle(docx, target, { driveFileId: "drive-doc" });
    const second = ingestDocxContentBundle(docx, target, { driveFileId: "drive-doc" });
    assert.equal(first.imported.length, 1); assert.deepEqual(first, second);
    const item = new ContentLibrary({ roots: [target] }).index()[0];
    assert.equal(item.articleId, "VBE-20260920-050"); assert.equal(item.assets.length, 2);
    assert.equal(item.assets[0].role, "cover"); assert.equal(item.assets[1].role, "gallery_image");
    assert.equal(item.readiness, "READY"); assert.ok(!item.blockingReasons.includes("VISUAL_QA_PENDING")); assert.equal(item.canonicalDocument.driveFileId, "drive-doc");
    assert.match(readFileSync(item.payloads.facebook!, "utf8"), /FB正文/);
    const transcript=join(target,"VBE-20260920-050","VBE-20260920-050-source-full-text-internal.md");
    assert.match(readFileSync(transcript,"utf8"),/LI正文/);
    assert.match(readFileSync(transcript,"utf8"),/小红书正文/);
    assert.match(readFileSync(transcript,"utf8"),/内部/);
    assert.ok(item.sourceEvidence.some(path=>path.endsWith("VBE-20260920-050-source-full-text-internal.md")));
    assert.doesNotMatch(readFileSync(item.payloads.wechat_official_account!,"utf8"),/内部/);
    const manifest = JSON.parse(readFileSync(join(target, "VBE-20260920-050", "manifest.json"), "utf8"));
    assert.equal(manifest.publication_authorized, false, "ingestion must never grant publication approval");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DOCX refresh preserves independently sourced history infographics and provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "docx-ingest-merge-"));
  try {
    const unpacked = join(root, "docx"), word = join(unpacked, "word"), target = join(root, "content"), article = join(target, "VBE-20260920-050");
    mkdirSync(join(word, "_rels"), { recursive: true }); mkdirSync(join(word, "media")); mkdirSync(article, {recursive:true});
    const paragraphs = ["VBE-20260920-050｜标题", "【头图｜COVER_QA_PASS】", "【微信公众号母稿】", "公开正文", "【Facebook】", "FB", "【小红书】", "XHS", "【SEO】"]
      .map((text,index)=>`<w:p><w:r><w:t>${text}</w:t>${index===1?'<w:drawing><a:blip r:embed="rId1"/></w:drawing>':''}</w:r></w:p>`).join("");
    writeFileSync(join(word,"document.xml"),`<w:document>${paragraphs}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');
    writeFileSync(join(word,"media","image1.png"),"cover");
    const docx=join(root,"bundle.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});
    const history="VBE-20260920-050_body_main_QA_PASS.png";writeFileSync(join(article,history),"history");
    writeFileSync(join(article,"manifest.json"),JSON.stringify({article_id:"VBE-20260920-050",active_assets:[history],asset_sources:{[history]:{source_kind:"GOOGLE_DRIVE_HISTORY",drive_file_id:"drive-image",role:"BODY_INFOGRAPHIC",sequence:0}}}));
    ingestDocxContentBundle(docx,target,{driveFileId:"drive-doc"});
    const manifest=JSON.parse(readFileSync(join(article,"manifest.json"),"utf8"));
    assert.deepEqual(manifest.active_assets,["cover_INGESTED.png",history]);
    assert.equal(manifest.asset_sources[history].drive_file_id,"drive-image");
    assert.equal(new ContentLibrary({roots:[target]}).index()[0].assets.length,2);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("canonical rewrite parser isolates public mother copy while retaining figure caption and source",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-canonical-gate-"));
  try{
    const unpacked=join(root,"docx"),word=join(unpacked,"word");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(join(word,"media"));
    const values=["VBE-20260916-041｜重写稿","content_id: VBE-20260916-041","title: 老板最该看的是异常清单","【公开母稿｜微信公众号】","老板最该看的是异常清单","公开正文","【VISUAL_ASSET_MANIFEST｜内部字段】","active_assets: cover_QA_PASS.png","【正文高密度信息图】","图 01｜管理异常清单","VietBridge 驻越经营实录｜原创管理工具","【Facebook适配】","不应泄漏的FB方向","【正文高密度信息图规格】","不应泄漏的图片规格","【INTERNAL QA｜不得发布】","FACT_QA: PASS"];
    const paragraphs=values.map((value,index)=>`<w:p><w:r><w:t>${value}</w:t>${index===6?'<w:drawing><a:blip r:embed="rId1"/></w:drawing>':''}</w:r></w:p>`).join('');
    writeFileSync(join(word,"document.xml"),`<w:document>${paragraphs}</w:document>`);writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');writeFileSync(join(word,"media","image1.png"),'image');
    const docx=join(root,"canonical.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});const target=join(root,"target");ingestDocxContentBundle(docx,target,{driveFileId:"canonical-doc"});
    const item=new ContentLibrary({roots:[target]}).index()[0],payload=readFileSync(item.payloads.wechat_official_account!,"utf8");
    assert.equal(item.title,"老板最该看的是异常清单");assert.equal(item.assets.length,1);assert.equal(item.canonicalSource,true);
    assert.match(payload,/公开正文/);assert.match(payload,/图 01｜管理异常清单/);assert.match(payload,/原创管理工具/);
    assert.doesNotMatch(payload,/content_id|Facebook适配|FB方向|信息图规格|INTERNAL QA|FACT_QA|【正文高密度信息图】|VISUAL_ASSET_MANIFEST|active_assets/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("DOCX Heading 2 and Heading 3 styles survive WeChat public-copy ingestion",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-wechat-headings-"));
  try{
    const unpacked=join(root,"docx"),word=join(unpacked,"word");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(join(word,"media"));
    const rows=[
      ["VBE-20260923-072｜业务边界盘点",""],
      ["【公开母稿｜微信公众号】",""],
      ["导语。",""],
      ["时间线","Heading2"],
      ["规则细节","Heading3"],
      ["第 7 条还明确持续条件。",""],
      ["【Facebook版本】",""]
    ];
    const xml=rows.map(([value,style])=>`<w:p>${style?`<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`:""}<w:r>${value==='规则细节'?'<w:rPr><w:color w:val="AA3322"/></w:rPr>':''}<w:t>${value}</w:t></w:r></w:p>`).join('');
    writeFileSync(join(word,"document.xml"),`<w:document>${xml}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships/>');
    const docx=join(root,"bundle.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});
    ingestDocxContentBundle(docx,join(root,"content"));
    const payload=readFileSync(join(root,"content","VBE-20260923-072","VBE-20260923-072-wechat-public.md"),"utf8");
    assert.match(payload,/^## 时间线$/m);
    assert.match(payload,/^<h3 style="color:#AA3322">规则细节<\/h3>$/m);
    assert.match(payload,/^第 7 条还明确持续条件。$/m);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("canonical DOCX preserves inline image order and Version platform sections",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-inline-order-"));
  try{
    const unpacked=join(root,"docx"),word=join(unpacked,"word"),media=join(word,"media");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(media);
    const rows=[["VBE-20260923-072｜title",""],["content_id: VBE-20260923-072",""],["title: 业务边界盘点",""],["【公开母稿｜微信公众号】",""],["引题",""],["","rId1"],["图 01｜事实图",""],["VietBridge 驻越经营实录｜原创管理工具",""],["图片后的解释",""],["","rId2"],["图 02｜框架图",""],["【Facebook版本】",""],["Facebook公开文案",""],["【LinkedIn版本】",""],["LinkedIn公开文案",""],["【小红书版本】",""],["小红书公开文案",""],["【SEO_QA】",""],["内部检查文本",""]];
    const paragraphs=rows.map(row=>'<w:p><w:r>'+(row[0]?'<w:t>'+row[0]+'</w:t>':'')+(row[1]?'<w:drawing><a:blip r:embed="'+row[1]+'"/></w:drawing>':'')+'</w:r></w:p>').join('');
    writeFileSync(join(word,"document.xml"),'<w:document>'+paragraphs+'</w:document>');
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/><Relationship Id="rId2" Target="media/image2.png"/></Relationships>');
    writeFileSync(join(media,"image1.png"),"one");writeFileSync(join(media,"image2.png"),"two");
    const docx=join(root,"canonical.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});
    const target=join(root,"target");
    ingestDocxContentBundle(docx,target,{driveFileId:"canonical-doc",activeAssetOverrides:{"VBE-20260923-072":[
      {filename:"VBE-20260923-072_COVER_V01.png",role:"cover",driveFileId:"cover-drive"},
      {filename:"VBE-20260923-072_BODY_FACT_V01.png",role:"body",driveFileId:"body-drive"}
    ]}});
    const item=new ContentLibrary({roots:[target]}).index()[0],wechat=readFileSync(item.payloads.wechat_official_account!,"utf8");
    assert.ok(wechat.indexOf("![图 01｜事实图](VBE-20260923-072_COVER_V01.png)")<wechat.indexOf("图 01｜事实图"));
    assert.ok(wechat.indexOf("图片后的解释")<wechat.indexOf("![图 02｜框架图](VBE-20260923-072_BODY_FACT_V01.png)"));
    assert.match(readFileSync(item.payloads.facebook!,"utf8"),/Facebook公开文案/);
    assert.match(readFileSync(item.payloads.linkedin!,"utf8"),/LinkedIn公开文案/);
    assert.match(readFileSync(item.payloads.xiaohongshu!,"utf8"),/小红书公开文案/);
    assert.deepEqual(item.assets.map(asset=>[asset.filename,asset.role]),[["VBE-20260923-072_COVER_V01.png","cover"],["VBE-20260923-072_BODY_FACT_V01.png","gallery_image"]]);
    assert.doesNotMatch(wechat,/content_id:|Facebook版本|SEO_QA|内部检查文本/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("Google Doc FULL_DRAFT blocks merge by content id and inline images materialize without passing QA",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-full-draft-inline-"));
  try{
    const unpacked=join(root,"docx"),word=join(unpacked,"word"),media=join(word,"media");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(media);
    const rows=[
      ["existing_content: VBE-20260928-090",""],["Goertek existing article; do not create a replacement",""],
      ["content_id: VBE-20260928-091",""],["title: Working title",""],["status: DRAFT_FACT_QA",""],
      ["content_id: VBE-20260928-092",""],["title: Second article",""],
      ["FULL_DRAFT_V1｜VBE-20260928-091",""],["# Final article title",""],["Verified body copy",""],["", "rId1"],["图 01｜主图说明",""],["QA: FACT_DRAFT_PASS | FULL_VISUAL_QA_PENDING | NOT_READY",""],
      ["FULL_DRAFT_V1｜VBE-20260928-092",""],["# Second article",""],["Second body",""],["","rId2"],["QA: NOT_READY","" ]
    ];
    const paragraphs=rows.map(([value,rid])=>`<w:p><w:r>${value?`<w:t>${value}</w:t>`:""}${rid?`<w:drawing><a:blip r:embed="${rid}"/></w:drawing>`:""}</w:r></w:p>`).join("");
    writeFileSync(join(word,"document.xml"),`<w:document>${paragraphs}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/one.png"/><Relationship Id="rId2" Target="media/two.png"/></Relationships>');
    writeFileSync(join(media,"one.png"),"image-one");writeFileSync(join(media,"two.png"),"image-two");
    const docx=join(root,"bundle.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});
    const target=join(root,"content"),result=ingestDocxContentBundle(docx,target,{driveFileId:"google-doc"});
    assert.equal(result.imported.length,2,"duplicate full-draft ID is merged instead of producing another ContentItem");
    const items=new ContentLibrary({roots:[target]}).index();assert.equal(items.length,2);
    const item=items.find(x=>x.articleId==="VBE-20260928-091")!;
    assert.equal(item.title,"Final article title");assert.equal(item.assets.length,1);
    const payload=readFileSync(item.payloads.wechat_official_account!,"utf8");
    assert.match(payload,/Verified body copy/);assert.match(payload,/\!\[图 01｜主图说明\]\(body_01_INGESTED\.png\)/);
    assert.doesNotMatch(payload,/QA:|DRAFT_FACT_QA|INTERNAL FACT NOTE|NOT_READY/);
    const manifest=JSON.parse(readFileSync(join(target,item.articleId,"manifest.json"),"utf8"));
    assert.equal(manifest.qa_status,"PENDING_FACT_QA");assert.equal(manifest.visual_qa_status,"PENDING");
    assert.equal(item.readiness,"READY");assert.ok(!item.blockingReasons.includes("VISUAL_QA_PENDING"));
    assert.ok(!item.blockingReasons.includes("FACT_QA_PENDING"));
    assert.equal(item.assets[0].qaState,"UNKNOWN","embedded-image ingestion must not imply image QA pass");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("Markdown-style Google Docs platform headings preserve each GPT copy and inline article images",()=>{
  const root=mkdtempSync(join(tmpdir(),"docx-markdown-platforms-"));
  try{
    const unpacked=join(root,"docx"),word=join(unpacked,"word"),media=join(word,"media");mkdirSync(join(word,"_rels"),{recursive:true});mkdirSync(media);
    const rows=[
      ["VBE-20260928-085｜越南工业集群新规",""],["content_id: VBE-20260928-085",""],["title: 越南工业集群新规",""],["series: 驻越经营实录",""],
      ["# 微信公众号母稿",""],["微信公众号导语，先讲选厂不能只看租金。",""],["## 一、核对入住率与基础设施",""],["核验道路、供水和污水处理是否真实可用。","rId1"],
      ["## Facebook版",""],["Facebook 独立文案。",""],["## LinkedIn版",""],["LinkedIn 独立文案。",""],["## 小红书版",""],["小红书独立文案。",""],["## SEO QA",""],["不得进入公开稿的内部 QA。",""],
      ["VBE-20260928-087｜TCL案例",""],["content_id: VBE-20260928-087",""],["title: TCL在越南的25年",""],["series: 驻越经营实录",""],
      ["# TCL在越南的25年",""],["独立案例叙事草稿，不是指定的微信平台版本。",""],["## 微信公众号版本",""],["# TCL在越南的25年",""],["微信正式稿：先核对经营转折，再讲管理启示。","rId2"],
      ["## Facebook版本",""],["TCL Facebook copy.",""],["## LinkedIn版本",""],["TCL LinkedIn copy.",""],["## 小红书版本",""],["TCL 小红书 copy.",""],["## 事实核查与来源",""],["内部来源核查，不得公开。",""]
    ];
    const paragraphs=rows.map(([value,rid])=>`<w:p><w:r>${value?`<w:t>${value}</w:t>`:""}${rid?`<w:drawing><a:blip r:embed="${rid}"/></w:drawing>`:""}</w:r></w:p>`).join("");
    writeFileSync(join(word,"document.xml"),`<w:document>${paragraphs}</w:document>`);
    writeFileSync(join(word,"_rels","document.xml.rels"),'<Relationships><Relationship Id="rId1" Target="media/one.png"/><Relationship Id="rId2" Target="media/two.png"/></Relationships>');
    writeFileSync(join(media,"one.png"),"image-one");writeFileSync(join(media,"two.png"),"image-two");
    const docx=join(root,"bundle.docx");execFileSync("zip",["-q","-r",docx,"word"],{cwd:unpacked});
    const target=join(root,"content");ingestDocxContentBundle(docx,target,{driveFileId:"markdown-drive-doc"});
    const library=new ContentLibrary({roots:[target]}),items=library.index();assert.equal(items.length,2);
    const industrial=items.find(x=>x.articleId==="VBE-20260928-085")!;
    const industrialWechat=readFileSync(industrial.payloads.wechat_official_account!,"utf8");
    assert.match(industrialWechat,/微信公众号导语/);assert.match(industrialWechat,/道路、供水和污水处理/);assert.match(industrialWechat,/!\[body_01_INGESTED\.png\]\(body_01_INGESTED\.png\)/);
    assert.match(readFileSync(industrial.payloads.facebook!,"utf8"),/Facebook 独立文案/);assert.match(readFileSync(industrial.payloads.linkedin!,"utf8"),/LinkedIn 独立文案/);assert.match(readFileSync(industrial.payloads.xiaohongshu!,"utf8"),/小红书独立文案/);
    assert.doesNotMatch(industrialWechat,/不得进入公开稿|SEO QA|Facebook 独立文案/);
    const tcl=items.find(x=>x.articleId==="VBE-20260928-087")!,tclWechat=readFileSync(tcl.payloads.wechat_official_account!,"utf8");
    assert.match(tclWechat,/微信正式稿/);assert.doesNotMatch(tclWechat,/独立案例叙事草稿|Facebook copy|内部来源核查/);
    const tclSource=tcl.sourceEvidence.find(path=>path.endsWith("VBE-20260928-087-source-full-text-internal.md"))!;
    assert.match(readFileSync(tclSource,"utf8"),/独立案例叙事草稿/);
    assert.match(readFileSync(tclSource,"utf8"),/TCL Facebook copy/);
    assert.match(readFileSync(tcl.payloads.facebook!,"utf8"),/TCL Facebook copy/);assert.match(readFileSync(tcl.payloads.linkedin!,"utf8"),/TCL LinkedIn copy/);assert.match(readFileSync(tcl.payloads.xiaohongshu!,"utf8"),/TCL 小红书 copy/);
    assert.equal(tcl.assets.length,1);assert.ok(industrial.assets.length>=1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
