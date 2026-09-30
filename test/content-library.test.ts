import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { ContentLibrary } from "../src/content-library.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "content-library-"));
  const content = join(root, "content"); mkdirSync(content);
  const image = Buffer.from([137,80,78,71,13,10,26,10,1]);
  writeFileSync(join(content, "Daily-044-cover.png"), image);
  writeFileSync(join(content, "Daily-044-facebook-public.txt"), "越南消防变更别跳步\n正文");
  writeFileSync(join(content, "Daily-044-xiaohongshu-public.txt"), "越南消防变更别跳步\n正文");
  writeFileSync(join(root, "ledger.yaml"), "published_history:\n  Daily-044:\n    facebook:\n      status: PUBLISHED\n");
  return { root, content, image, library: new ContentLibrary({ roots: [content], ledgerPath: join(root, "ledger.yaml") }) };
}

test("WeChat companion public copy is recognized without using the internal mother draft", () => {
  const f = fixture();
  try {
    const publicPath = join(f.content, "Daily-044-wechat-companion-public.md");
    writeFileSync(publicPath, "# 公众号公开文章\n正文");
    writeFileSync(join(f.content, "Daily-044-wechat-internal.md"), "内部审核记录，不得发布");
    const result = f.library.resolve({mode:"article_id",value:"Daily-044",platforms:["wechat_official_account"]});
    assert.equal(result.status,"MATCHED");
    if(result.status === "MATCHED") assert.equal(result.package.payloads.wechat_official_account,realpathSync(publicPath));
  } finally { rmSync(f.root, {recursive:true,force:true}); }
});

test("exact file hydrates complete package and ledger disables published platform", () => {
  const f = fixture();
  try {
    const result = f.library.resolve({ mode: "local_path", value: join(f.content, "Daily-044-cover.png"), platforms: ["facebook", "xiaohongshu"] });
    assert.equal(result.status, "MATCHED");
    if (result.status !== "MATCHED") return;
    assert.equal(result.package.articleId, "Daily-044");
    assert.ok(result.package.payloads.facebook);
    assert.deepEqual(result.disabledPlatforms, ["facebook"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("later verified deletion overrides historical published evidence",()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.root,"verified-publications.jsonl"),[
      JSON.stringify({article_id:"Daily-044",platform:"facebook",status:"PUBLISHED"}),
      JSON.stringify({article_id:"Daily-044",platform:"facebook",status:"PLATFORM_DELETED"})
    ].join("\n")+"\n");
    assert.deepEqual(f.library.readPublishedPlatforms().get("Daily-044"),[]);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('manifestless video revisions do not combine media across directories',()=>{
 const f=fixture();
 try{
  for(const revision of ['v2','v4']) {
   const dir=join(f.content,'TT-20260810-ENT-01-'+revision);mkdirSync(dir);
   writeFileSync(join(dir,'TT-20260810-ENT-01.mp4'),'video-'+revision);
   writeFileSync(join(dir,'TT-20260810-ENT-01-xiaohongshu-public.txt'),'公开标题\n正文');
  }
  const packages=f.library.index().filter(p=>p.articleId==='TT-20260810-ENT-01');
  assert.equal(packages.length,2);
  assert.ok(packages.every(p=>p.assets.filter(a=>a.role==='video').length===1));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("keyword produces candidates, file bytes match, and arbitrary https is rejected", () => {
  const f = fixture();
  try {
    assert.equal(f.library.resolve({ mode: "search", value: "消防" }).status, "CANDIDATES");
    assert.equal(f.library.resolveBytes(f.image).status, "MATCHED");
    const remote = f.library.resolve({ mode: "url", value: "https://example.com/file.mp4" });
    assert.equal(remote.status, "REJECTED");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("symlink escape is rejected", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside.png"); writeFileSync(outside, f.image);
    const link = join(f.content, "Daily-045-cover.png"); symlinkSync(outside, link);
    const result = f.library.resolve({ mode: "local_path", value: link });
    assert.equal(result.status, "REJECTED");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("duplicate YAML records and resource-queue Channels evidence are merged", () => {
  const root = mkdtempSync(join(tmpdir(), "content-ledger-merge-"));
  try {
    const content = join(root, "TT-20260823-ENT-08-Daily048");
    mkdirSync(join(content, "final"), { recursive: true });
    mkdirSync(join(content, "public"));
    writeFileSync(join(content, "manifest.json"), JSON.stringify({ article_id: "Daily-048", title: "title: 测试标题", version: "v1" }));
    writeFileSync(join(content, "final", "Daily-048.mp4"), Buffer.from("video"));
    writeFileSync(join(content, "public", "Daily-048-xiaohongshu-public.txt"), "测试标题\n正文");
    const ledger = join(root, "ledger.yaml");
    writeFileSync(ledger, `published_history:
  Daily-048:
    facebook: {status: PUBLISHED}
  Daily-048:
    xiaohongshu: {status: PUBLISHED}
resource_queue:
  TT-20260823-ENT-08:
    article_id: Daily-048
    shipinhao:
      status: PUBLISHED
    wechat:
      prior_revision_status: DRAFT_API_WRITTEN_NOT_PUBLISHED
    xiaohongshu:
      current_revision_status: FAILED
      live_request_sent_for_current_revision: true
`);
    const item = new ContentLibrary({ roots: [content], ledgerPath: ledger }).index()[0];
    assert.equal(item.title, "测试标题");
    assert.deepEqual(item.publishedPlatforms.sort(), ["facebook", "wechat_channels", "wechat_official_account", "xiaohongshu"]);
    assert.equal(item.payloads.wechat_channels, item.payloads.xiaohongshu);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("placeholder manifest title is replaced by approved payload heading", () => {
  const root = mkdtempSync(join(tmpdir(), "content-title-fallback-"));
  try {
    const content = join(root, "TT-20260901-ENT-13"); mkdirSync(content);
    writeFileSync(join(content, "manifest.json"), JSON.stringify({ article_id: "TT-20260901-ENT-13", title: "TT-20260901-ENT-13" }));
    writeFileSync(join(content, "TT-20260901-ENT-13-xiaohongshu-public.txt"), "---\ntitle: 越南工会经费不是可选项\n---\n正文");
    writeFileSync(join(content, "TT-20260901-ENT-13-cover.png"), Buffer.from([137,80,78,71,13,10,26,10,1]));
    const item = new ContentLibrary({ roots: [content] }).index()[0];
    assert.equal(item.title, "越南工会经费不是可选项");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("VBE packages are recognized and manifest active_assets suppress obsolete revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "content-vbe-"));
  try {
    const content = join(root, "VBE-20260915-021"); mkdirSync(content);
    writeFileSync(join(content, "manifest.json"), JSON.stringify({
      article_id: "VBE-20260915-021",
      title: "Tesla越南公司成立",
      active_assets: ["cover-QA.png", "body-01-QA.png"]
    }));
    writeFileSync(join(content, "cover-old.png"), Buffer.from("old"));
    writeFileSync(join(content, "cover-QA.png"), Buffer.from("cover"));
    writeFileSync(join(content, "body-01-QA.png"), Buffer.from("body"));
    writeFileSync(join(content, "VBE-20260915-021-facebook-public.txt"), "Tesla越南公司成立\n正文");
    const library = new ContentLibrary({ roots: [content] });
    const result = library.resolve({mode:"article_id",value:"VBE-20260915-021",platforms:["facebook"]});
    assert.equal(result.status, "MATCHED");
    if (result.status !== "MATCHED") return;
    assert.equal(result.package.articleId, "VBE-20260915-021");
    assert.deepEqual(result.package.assets.map(asset => basename(asset.path)), ["cover-QA.png", "body-01-QA.png"]);
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test("public payload internal production markers fail closed",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-public-leak-"));
  try{
    const content=join(root,"VBE-20260920-050");mkdirSync(content);
    writeFileSync(join(content,"manifest.json"),JSON.stringify({article_id:"VBE-20260920-050",source_doc_id:"doc",qa_status:"PASS",active_assets:["cover_QA_PASS.png"]}));
    writeFileSync(join(content,"cover_QA_PASS.png"),Buffer.from("cover"));
    writeFileSync(join(content,"VBE-20260920-050-wechat-public.md"),"# 标题\n公开正文\n【培训转化钩子】\n公开服务说明");
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.equal(item.readiness,"BLOCKED");
    assert.ok(item.blockingReasons.includes("PUBLIC_PAYLOAD_INTERNAL_LEAK"));
    assert.match(String(item.blockingDetail),/TRAINING_CONVERSION_INTERNAL_HEADING/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("visual asset manifest embedded in a public article blocks new publication",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-visual-manifest-leak-"));
  try{
    const content=join(root,"VBE-20260923-072");mkdirSync(content);
    writeFileSync(join(content,"manifest.json"),JSON.stringify({article_id:"VBE-20260923-072",source_doc_id:"doc",active_assets:["cover_QA_PASS.png"]}));
    writeFileSync(join(content,"cover_QA_PASS.png"),Buffer.from("cover"));
    writeFileSync(join(content,"VBE-20260923-072-wechat-public.md"),"# 正式标题\n正文\n【VISUAL_ASSET_MANIFEST｜内部字段】\nactive_assets: cover_QA_PASS.png");
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.equal(item.readiness,"BLOCKED");
    assert.ok(item.blockingReasons.includes("PUBLIC_PAYLOAD_INTERNAL_LEAK"));
    assert.match(String(item.blockingDetail),/VISUAL_ASSET_MANIFEST_INTERNAL/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("VBE image package requires a passing density report or explicit visual confirmation",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-visual-qa-gate-"));
  try{
    const content=join(root,"VBE-20260920-051");mkdirSync(content);
    const manifestPath=join(content,"manifest.json");
    const metadata={article_id:"VBE-20260920-051",source_doc_id:"doc",qa_status:"PASS",active_assets:["cover_QA_PASS.png","body_QA_PASS.png"]};
    writeFileSync(manifestPath,JSON.stringify(metadata));
    writeFileSync(join(content,"cover_QA_PASS.png"),Buffer.from("cover"));
    writeFileSync(join(content,"body_QA_PASS.png"),Buffer.from("body"));
    writeFileSync(join(content,"VBE-20260920-051-wechat-public.md"),"# 标题\n正文");
    const library=new ContentLibrary({roots:[content]});
    const pending=library.index()[0];
    assert.equal(pending.readiness,"BLOCKED");
    assert.ok(pending.blockingReasons.includes("VISUAL_QA_PENDING"));
    assert.match(String(pending.blockingDetail),/信息密度/);
    const reportName="visual_density_report.json";
    writeFileSync(join(content,reportName),JSON.stringify({status:"PASS",metrics:{information_quality_score:86},failures:[]}));
    writeFileSync(manifestPath,JSON.stringify({...metadata,visual_qa_status:"PASS",visual_density_report:reportName}));
    assert.equal(library.index()[0].readiness,"READY");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("legacy body-image placement marker is auto-resolved when a canonical body asset exists",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-placement-marker-"));
  try{
    const content=join(root,"VBE-20260915-020");mkdirSync(content);
    writeFileSync(join(content,"manifest.json"),JSON.stringify({article_id:"VBE-20260915-020",source_doc_id:"doc",qa_status:"PASS",visual_qa_status:"USER_CONFIRMED",visual_qa_evidence:"test fixture",active_assets:["body_01_QA_PASS.png"]}));
    writeFileSync(join(content,"body_01_QA_PASS.png"),Buffer.from("body"));
    writeFileSync(join(content,"VBE-20260915-020-wechat-public.md"),"# 标题\n公开正文\n【正文高密度信息图】");
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.equal(item.readiness,"READY");
    assert.ok(!item.blockingReasons.includes("PUBLIC_PAYLOAD_INTERNAL_LEAK"));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("declared frontload remains the cover ahead of alphabetically earlier body image",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-cover-order-"));
  try{
    const content=join(root,"VBE-20260920-060");mkdirSync(content);
    const front="VBE-20260920-060_FRONTLOAD_EDITORIAL_V02.png";
    const body="VBE-20260920-060_BODY_EVIDENCE_MAP_V02.png";
    writeFileSync(join(content,"manifest.json"),JSON.stringify({
      article_id:"VBE-20260920-060",source_doc_id:"doc",qa_status:"PASS",
      visual_qa_status:"USER_CONFIRMED",visual_qa_evidence:"test fixture",
      active_assets:[front,body],
      asset_sources:{[front]:{role:"BODY_INFOGRAPHIC",sequence:0},[body]:{role:"BODY_INFOGRAPHIC",sequence:1}}
    }));
    writeFileSync(join(content,front),Buffer.from("front"));
    writeFileSync(join(content,body),Buffer.from("body"));
    writeFileSync(join(content,"VBE-20260920-060-wechat-public.md"),"# 公开标题\n正文");
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.equal(item.readiness,"READY");
    assert.deepEqual(item.assets.map(asset=>[asset.filename,asset.role,asset.sequence]),[
      [front,"cover",0],[body,"gallery_image",1]
    ]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("production-pending public article is not made ready by resolved assets",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-pending-public-"));
  try{
    const content=join(root,"VBE-20260915-020");mkdirSync(content);
    const manifest=join(content,"manifest.json");
    const metadata={article_id:"VBE-20260915-020",source_doc_id:"doc",qa_status:"PASS",visual_qa_status:"USER_CONFIRMED",visual_qa_evidence:"test fixture",library_status:"ASSET_INGESTED_PUBLIC_PAYLOAD_PENDING",active_assets:["body_01_QA_PASS.png"]};
    writeFileSync(manifest,JSON.stringify(metadata));
    writeFileSync(join(content,"body_01_QA_PASS.png"),Buffer.from("body"));
    writeFileSync(join(content,"VBE-20260915-020-wechat-public.md"),"# 标题\n公开正文\n【正文高密度信息图】");
    const library=new ContentLibrary({roots:[content]});
    const pending=library.index()[0];
    assert.equal(pending.readiness,"BLOCKED");
    assert.deepEqual(pending.blockingReasons,["CONTENT_QA_PENDING"]);
    writeFileSync(manifest,JSON.stringify({...metadata,library_status:"CONTENT_QA_PASS"}));
    assert.equal(library.index()[0].readiness,"READY");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("explicit independent rewrite suppresses a historical duplicate without deleting evidence",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-canonical-priority-"));
  try{
    for(const [name,canonical] of [["history",false],["rewrite",true]] as const){const dir=join(root,`VBE-20260916-041-${name}`);mkdirSync(dir);writeFileSync(join(dir,"manifest.json"),JSON.stringify({article_id:"VBE-20260916-041",source_doc_id:name,canonical_source:canonical?"independent_rewrite_doc":undefined,active_assets:["body_01_QA_PASS.png"],qa_status:"PASS"}));writeFileSync(join(dir,"body_01_QA_PASS.png"),name);writeFileSync(join(dir,"VBE-20260916-041-wechat-public.md"),`# ${name}\n正文`);}
    const items=new ContentLibrary({roots:[root]}).index();assert.equal(items.length,1);assert.equal(items[0].canonicalSource,true);assert.equal(items[0].duplicateCandidates,0);assert.equal(items[0].canonicalDocument.driveFileId,"rewrite");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("legacy compound Drive document reference is split into file id and article anchor",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-legacy-drive-ref-"));
  try{
    const content=join(root,"VBE-20260920-069");mkdirSync(content);
    writeFileSync(join(content,"manifest.json"),JSON.stringify({
      article_id:"VBE-20260920-069",
      source_doc_id:"native-google-doc-id#VBE-20260920-069",
      qa_status:"PASS",
      active_assets:["cover_QA_PASS.png"]
    }));
    writeFileSync(join(content,"cover_QA_PASS.png"),Buffer.from("cover"));
    writeFileSync(join(content,"VBE-20260920-069-wechat-public.md"),"# 标题\n正文");
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.equal(item.canonicalDocument.driveFileId,"native-google-doc-id");
    assert.equal(item.canonicalDocument.sourceAnchor,"VBE-20260920-069");
  }finally{rmSync(root,{recursive:true,force:true});}
});

function vbeFixture(options: {missingCover?: boolean; missingBody?: boolean} = {}) {
  const root = mkdtempSync(join(tmpdir(), "content-vbe-contract-"));
  const content = join(root, "VBE-20260915-021"); mkdirSync(content);
  const active = [
    ...(options.missingCover ? [] : ["cover_QA_PASS.png"]),
    ...(options.missingBody ? [] : [
      "body_03_tesla_starlink_QA_PASS.png",
      "body_01_fact_boundary_QA_PASS.png",
      "body_05_workshop_QA_PASS.png",
      "body_02_market_entry_ladder_QA_PASS.png",
      "body_04_commercial_loop_QA_PASS.png"
    ])
  ];
  writeFileSync(join(content, "manifest.json"), JSON.stringify({
    article_id: "VBE-20260915-021",
    title: "Tesla正式在越南设公司",
    source_doc_id: "1e5nQFJtsxFYmIiyRjFb6YYZCZqvxtd4DXOZMko5fVic",
    source_folder_id: "17ZwgJEhYtMZjjReeNtJvZACZT9Pdb5jK",
    qa_status: "PASS",
    visual_qa_status: "USER_CONFIRMED",
    visual_qa_evidence: "test fixture representing a manually reviewed visual package",
    active_assets: active
  }));
  for (const name of active) writeFileSync(join(content, name), Buffer.from(name));
  for (const platform of ["facebook", "linkedin", "wechat-public", "xiaohongshu"])
    writeFileSync(join(content, `VBE-20260915-021-${platform}-public.txt`), "Tesla正式在越南设公司\n正文");
  return {root, content, library: new ContentLibrary({roots:[content]})};
}

test("VBE sibling discovery keeps one ContentItem and classifies QA_PASS cover plus ordered body assets", () => {
  const f=vbeFixture();
  try {
    const first=f.library.index();
    const second=f.library.index();
    assert.equal(first.length,1, "images must not become ContentItems");
    assert.equal(second.length,1, "re-import must be idempotent");
    const item=first[0];
    assert.equal(item.assets.filter(asset=>asset.role==="cover").length,1);
    assert.deepEqual(item.assets.filter(asset=>asset.role==="gallery_image").map(asset=>asset.sequence),[1,2,3,4,5]);
    assert.ok(item.assets.every(asset=>asset.qaState==="PASS"));
    assert.deepEqual(second[0].assets.map(asset=>asset.assetId),item.assets.map(asset=>asset.assetId),"asset identity must be deterministic");
    assert.equal(new Set(item.assets.map(asset=>asset.assetId)).size,6);
    assert.equal(item.canonicalDocument.driveFileId,"1e5nQFJtsxFYmIiyRjFb6YYZCZqvxtd4DXOZMko5fVic");
    assert.equal(item.canonicalDocument.driveFolderId,"17ZwgJEhYtMZjjReeNtJvZACZT9Pdb5jK");
    assert.equal(item.readiness,"READY");
    assert.equal(item.unresolvedAssets.length,0);
    assert.ok(item.assets.every(asset=>asset.sha256===asset.revision&&asset.sizeBytes>0));
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test("same stable asset identity gets a new revision when bytes change", () => {
  const f=vbeFixture();
  try {
    const path=join(f.content,"body_02_market_entry_ladder_QA_PASS.png");
    const before=f.library.index()[0].assets.find(asset=>asset.filename===basename(path))!;
    writeFileSync(path,Buffer.from("replacement bytes with corrected layout"));
    const after=f.library.index()[0].assets.find(asset=>asset.filename===basename(path))!;
    assert.equal(after.assetId,before.assetId,"Drive/file identity remains stable");
    assert.notEqual(after.revision,before.revision,"binary replacement must rotate preview/cache revision");
    assert.notEqual(after.sha256,before.sha256);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test("all four article variants resolve the same canonical asset set", () => {
  const f=vbeFixture();
  try {
    const item=f.library.index()[0];
    const expected=item.assets.map(asset=>asset.assetId);
    for (const platform of ["wechat_official_account","facebook","linkedin","xiaohongshu"] as const)
      assert.deepEqual(item.variantAssets[platform],expected,`${platform} must resolve canonical assets`);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test("missing explicit cover uses the first body image, while a package with no images fails closed", () => {
  const missingCover=vbeFixture({missingCover:true});
  const missingBody=vbeFixture({missingBody:true});
  const missingAll=vbeFixture({missingCover:true,missingBody:true});
  try {
    const fallback=missingCover.library.index()[0];
    assert.equal(fallback.readiness,"READY");
    assert.equal(fallback.assets.find(asset=>asset.role==='cover')?.filename,'body_01_fact_boundary_QA_PASS.png');
    const ready=missingBody.library.index()[0];
    assert.equal(ready.readiness,"READY");
    assert.equal(ready.assets.filter(asset=>asset.role==="gallery_image").length,0);
    const blocked=missingAll.library.index()[0];
    assert.equal(blocked.readiness,"BLOCKED");
    assert.ok(blocked.blockingReasons.includes("COVER_MISSING"));
  } finally {
    rmSync(missingCover.root,{recursive:true,force:true});
    rmSync(missingBody.root,{recursive:true,force:true});
    rmSync(missingAll.root,{recursive:true,force:true});
  }
});

test("duplicate canonical VBE candidates are detected and blocked", () => {
  const root=mkdtempSync(join(tmpdir(),"content-vbe-duplicate-"));
  try {
    for(const suffix of ["a","b"]){
      const dir=join(root,`VBE-20260915-021-${suffix}`);mkdirSync(dir);
      writeFileSync(join(dir,"manifest.json"),JSON.stringify({article_id:"VBE-20260915-021",source_doc_id:"doc",active_assets:["cover_QA_PASS.png"]}));
      writeFileSync(join(dir,"cover_QA_PASS.png"),Buffer.from("cover"));
      writeFileSync(join(dir,"VBE-20260915-021-facebook-public.txt"),"标题\n正文");
    }
    const items=new ContentLibrary({roots:[root]}).index();
    assert.equal(items.length,2);
    assert.ok(items.every(item=>item.duplicateCandidates===1&&item.readiness==="BLOCKED"&&item.blockingReasons.includes("CANONICAL_ARTICLE_DUPLICATE")));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("manifest references to absent assets remain visible and block readiness", () => {
  const f=vbeFixture();
  try {
    const manifest=join(f.content,"manifest.json");
    const raw=JSON.parse(readFileSync(manifest,"utf8"));
    raw.active_assets.push("body_06_missing_QA_PASS.png");
    writeFileSync(manifest,JSON.stringify(raw));
    const item=f.library.index()[0];
    assert.deepEqual(item.unresolvedAssets,["body_06_missing_QA_PASS.png"]);
    assert.equal(item.readiness,"BLOCKED");
    assert.ok(item.blockingReasons.includes("ASSET_REFERENCE_UNRESOLVED"));
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test("production-manifest in a manifest subdirectory owns the whole article package", () => {
  const root=mkdtempSync(join(tmpdir(),"content-production-manifest-"));
  try {
    const content=join(root,"TT-20260815-ENT-05-Daily049-v1");
    mkdirSync(join(content,"manifest"),{recursive:true});mkdirSync(join(content,"final"));mkdirSync(join(content,"cover"));mkdirSync(join(content,"public"));
    writeFileSync(join(content,"manifest","production-manifest.json"),JSON.stringify({article_id:"Daily-049",video_id:"TT-20260815-ENT-05",title:"外债还本付息",status:"READY_FOR_USER_APPROVAL"}));
    writeFileSync(join(content,"final","Daily-049-final.mp4"),"video");
    writeFileSync(join(content,"cover","Daily-049-cover.png"),"cover");
    writeFileSync(join(content,"public","Daily-049-xiaohongshu-public.txt"),"外债还本付息\n正文");
    const items=new ContentLibrary({roots:[root]}).index();
    assert.equal(items.length,1);
    assert.equal(items[0].articleId,"Daily-049");
    assert.equal(items[0].packageRoot,realpathSync(content));
    assert.equal(items[0].assets.filter(asset=>asset.role==='video').length,1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("video production approval flags do not block operator task creation", () => {
  const root=mkdtempSync(join(tmpdir(),"content-video-batch-"));
  try {
    for(const dir of ["manifest","public-payloads","final","covers"])mkdirSync(join(root,dir));
    for(const id of ["VIDEO-074-SITE-EXPANSION","VIDEO-075-ORDER-PNL"]){
      writeFileSync(join(root,"manifest",`${id}.json`),JSON.stringify({item_id:id,status:"QA_PASSED",publication_permission:false}));
      writeFileSync(join(root,"public-payloads",`${id}.md`),`# ${id}\n公开正文`);
      writeFileSync(join(root,"final",`${id}-final.mp4`),`video-${id}`);
      writeFileSync(join(root,"covers",`${id}-cover.png`),`cover-${id}`);
    }
    const first=new ContentLibrary({roots:[root]}).index(),second=new ContentLibrary({roots:[root]}).index();
    assert.deepEqual(first.map(item=>item.articleId).sort(),["VIDEO-074-SITE-EXPANSION","VIDEO-075-ORDER-PNL"]);
    assert.deepEqual(second.map(item=>item.articleId),first.map(item=>item.articleId),"re-import remains deterministic");
    for(const item of first){
      assert.ok(item.payloads.facebook&&item.payloads.xiaohongshu&&item.payloads.wechat_channels);
      assert.equal(item.assets.filter(asset=>asset.role==='video').length,1);
      assert.equal(item.assets.filter(asset=>asset.role==='cover').length,1);
      assert.equal(item.readiness,"READY");
      assert.ok(!item.blockingReasons.includes("APPROVAL_REQUIRED"));
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('video caption falls back to declared narration, while video-public filenames take priority',()=>{
  const root=mkdtempSync(join(tmpdir(),'VIDEO-099-CAPTION-'));
  try {
    const id='VIDEO-099-CAPTION';
    writeFileSync(join(root,'manifest.json'),JSON.stringify({item_id:id,script:'script.txt',publication_permission:false}));
    writeFileSync(join(root,'script.txt'),'工厂为什么经常延期？\n内部后续段落不应被复制');
    writeFileSync(join(root,`${id}-final.mp4`),'video');
    const library=new ContentLibrary({roots:[root]});
    const first=library.index()[0];
    assert.equal(first.readiness,'READY');
    assert.equal(first.title,'工厂为什么经常延期？');
    assert.equal(Object.keys(first.payloads).length,3);
    assert.doesNotMatch(readFileSync(first.payloads.facebook!,'utf8'),/内部后续/);
    assert.equal(library.index().length,1);
    writeFileSync(first.payloads.facebook!,'人工确认的正式文案\n\n#越南经营');
    assert.equal(readFileSync(library.index()[0].payloads.wechat_channels!,'utf8'),'人工确认的正式文案\n\n#越南经营');
    writeFileSync(join(root,'facebook-video-public.txt'),'正式视频标题\n正式发布说明');
    const updated=library.index()[0];
    assert.equal(updated.title,'正式视频标题');
    assert.match(readFileSync(updated.payloads.facebook!,'utf8'),/正式发布说明/);
    assert.equal(updated.payloads.wechat_official_account,undefined);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("legacy unnumbered body asset receives a stable non-conflicting sequence", () => {
  const f=vbeFixture();
  try {
    const manifest=join(f.content,"manifest.json");
    const raw=JSON.parse(readFileSync(manifest,"utf8"));
    raw.active_assets.splice(1,0,"body_main_QA_PASS.png");
    writeFileSync(manifest,JSON.stringify(raw));
    writeFileSync(join(f.content,"body_main_QA_PASS.png"),Buffer.from("main"));
    const first=f.library.index()[0],second=f.library.index()[0];
    assert.deepEqual(first.assets.filter(asset=>asset.role==="gallery_image").map(asset=>asset.sequence),[1,2,3,4,5,6]);
    assert.deepEqual(second.assets.map(asset=>asset.assetId),first.assets.map(asset=>asset.assetId));
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test("QA-passed body_main is promoted to cover when a package has no explicit cover", () => {
  const f=vbeFixture({missingCover:true});
  try {
    const manifest=join(f.content,"manifest.json");
    const raw=JSON.parse(readFileSync(manifest,"utf8"));
    raw.active_assets.unshift("body_main_QA_PASS.png");
    writeFileSync(manifest,JSON.stringify(raw));
    writeFileSync(join(f.content,"body_main_QA_PASS.png"),Buffer.from("main"));
    const item=f.library.index()[0];
    assert.equal(item.readiness,"READY");
    assert.equal(item.assets.find(asset=>asset.role==="cover")?.filename,"body_main_QA_PASS.png");
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test("legacy knowledge poster P1 is promoted to canonical cover and remaining pages stay ordered body images",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-legacy-cover-"));
  try{
    const content=join(root,"Daily-069");mkdirSync(content);
    for(const name of ['Daily-069-knowledge-poster-v2-p2-mechanism.png','Daily-069-knowledge-poster-v2-p1-route.png','Daily-069-knowledge-poster-v2-p3-checklist.png'])writeFileSync(join(content,name),Buffer.from(name));
    writeFileSync(join(content,'Daily-069-facebook-public.txt'),'正式标题\n正文');
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.equal(item.assets.filter(a=>a.role==='cover').length,1);
    assert.equal(item.assets.find(a=>a.role==='cover')?.filename,'Daily-069-knowledge-poster-v2-p1-route.png');
    assert.equal(item.readiness,'READY');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("legacy embedded cover token chooses one deterministic canonical cover",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-legacy-explicit-cover-"));
  try{
    const content=join(root,"Daily-068");mkdirSync(content);
    for(const name of ['Daily-068-cover-B-misconception.png','Daily-068-cover-A-consequence.png','Daily-068-p2-scope.png'])writeFileSync(join(content,name),Buffer.from(name));
    writeFileSync(join(content,'Daily-068-facebook-public.txt'),'正式标题\n正文');
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.deepEqual(item.assets.filter(a=>a.role==='cover').map(a=>a.filename),['Daily-068-cover-A-consequence.png']);
    assert.equal(item.assets.filter(a=>a.role==='gallery_image').length,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("video-only package is not blocked by the image cover gate",()=>{
  const root=mkdtempSync(join(tmpdir(),"content-video-no-cover-"));
  try{
    const content=join(root,"TT-20260919-ENT-99");mkdirSync(join(content,'final'),{recursive:true});
    writeFileSync(join(content,'manifest.json'),JSON.stringify({article_id:'TT-20260919-ENT-99',title:'视频标题'}));
    writeFileSync(join(content,'final','TT-20260919-ENT-99.mp4'),Buffer.from('video'));
    writeFileSync(join(content,'TT-20260919-ENT-99-xiaohongshu-public.txt'),'视频标题\n正文');
    const item=new ContentLibrary({roots:[content]}).index()[0];
    assert.equal(item.contentType,'video');assert.equal(item.readiness,'READY');assert.ok(!item.blockingReasons.includes('COVER_MISSING'));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("QA-failed package cannot bypass its active asset list with stale body images", () => {
  const f=vbeFixture({missingCover:true,missingBody:true});
  try {
    const manifest=join(f.content,"manifest.json");
    const raw=JSON.parse(readFileSync(manifest,"utf8"));
    raw.qa_status="FAIL";raw.active_assets=["BLOCKED_IMAGE_TOPIC_MISMATCH.png"];
    raw.blocking_issue="visual assets depict quality-system capacity, not the China-Vietnam inventory article";
    writeFileSync(manifest,JSON.stringify(raw));
    writeFileSync(join(f.content,"body_main_QA_PASS.png"),Buffer.from("stale"));
    const item=f.library.index()[0];
    assert.equal(item.readiness,"BLOCKED");
    assert.deepEqual(item.blockingReasons,["PACKAGE_QA_FAILED"]);
    assert.equal(item.assets.length,1);
    assert.equal(item.assets[0].role,"cover");
    assert.equal(item.assets[0].qaState,"FAIL");
    assert.deepEqual(item.unresolvedAssets,[]);
    assert.match(String(item.blockingDetail),/现有图片主题/);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});
