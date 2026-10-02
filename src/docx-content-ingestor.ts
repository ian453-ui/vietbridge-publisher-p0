import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { docxHeading, normalizeWechatHeadings } from "./wechat-heading-structure.ts";

type Article = { id: string; title: string; paragraphs: string[]; media: Array<{ path: string; role: "cover" | "body"; marker: string }> };
type ActiveAssetOverride = { filename: string; role: "cover" | "body"; driveFileId?: string; inlineObjectId?: string; semanticLabel?: string };

export type DocxIngestResult = {
  source: string;
  sourceRevision: string;
  imported: Array<{ articleId: string; title: string; assetCount: number; target: string }>;
};

export type InspectedDocxArticle = {
  articleId: string; title: string; series: string; status: string; publisherStatus: string;
  factStatus: string; visualStatus: string; bodyFingerprint: string; assetFingerprint: string;
  assetCount: number; sourceRevision: string; sourceUrl?: string;
};

/** Read every authored paragraph and embedded image for internal source review.
 * This deliberately does not infer a public payload or an image's cover role. */
export function readDocxSourceReview(sourceDocx:string,contentId:string){
  const sourcePath=resolve(sourceDocx);
  if(!existsSync(sourcePath)||extname(sourcePath).toLowerCase()!=='.docx')throw new Error('DOCX 内容包不存在');
  const article=parseArticles(zipText(sourcePath,'word/document.xml'),parseRelationships(zipText(sourcePath,'word/_rels/document.xml.rels')))
    .find(item=>item.id===contentId);
  if(!article)throw new Error('SOURCE_CONTENT_ID_NOT_FOUND');
  const fields:Record<string,string>={};
  for(const [index,paragraph] of article.paragraphs.entries()){
    const fieldLine=paragraph.replace(/\[\[VB_INLINE_MEDIA:[^\]]+\]\]/gu,'').trim();
    if(!fieldLine)continue;
    if(index===0&&fieldLine.startsWith(`${contentId}｜`))continue;
    if(/^#|^【/u.test(fieldLine))break;
    const match=fieldLine.match(/^([a-z][a-z0-9_]*)\s*[:：]\s*(.*)$/iu);
    if(match)fields[match[1].toLowerCase()]=match[2].trim();
    else break;
  }
  const sections=publicSections(article.paragraphs);
  const images=article.media.map((media,index)=>{
    const bytes=zipBytes(sourcePath,media.path),ext=normalizedImageExtension(media.path);
    return {index:index+1,filename:basename(media.path),mimeType:ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.webp'?'image/webp':'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),dataUrl:`data:${ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.webp'?'image/webp':'image/png'};base64,${bytes.toString('base64')}`};
  });
  return {articleId:contentId,title:fields.title||article.title,fields,paragraphs:article.paragraphs,publicCopies:sections,publicSections:{wechat:Boolean(sections.wechat),facebook:Boolean(sections.facebook),linkedin:Boolean(sections.linkedin),xiaohongshu:Boolean(sections.xiaohongshu)},images};
}

/** Read semantic identity from a Google Docs DOCX export without materializing it. */
export function inspectDocxContentBundle(sourceDocx: string): InspectedDocxArticle[] {
  const sourcePath=resolve(sourceDocx);
  if(!existsSync(sourcePath)||extname(sourcePath).toLowerCase()!=='.docx')throw new Error('DOCX 内容包不存在');
  const bytes=readFileSync(sourcePath),sourceRevision=createHash('sha256').update(bytes).digest('hex');
  const articles=parseArticles(zipText(sourcePath,'word/document.xml'),parseRelationships(zipText(sourcePath,'word/_rels/document.xml.rels')));
  return articles.map(article=>{
    const lines=article.paragraphs.filter(line=>!line.startsWith('[[VB_INLINE_MEDIA:'));
    const field=(name:string)=>lines.map(line=>line.match(new RegExp(`^${name}\\s*[:：]\\s*(.*)$`,'iu'))?.[1]).find(Boolean)?.trim()??'';
    const copy=publicSections(article.paragraphs).wechat;
    const body=copy.replace(/\[\[VB_INLINE_MEDIA:[^\]]+\]\]/gu,' [IMAGE] ').replace(/\s+/gu,' ').trim();
    const assets=article.media.map((media,index)=>({index,role:media.role,sha256:createHash('sha256').update(zipBytes(sourcePath,media.path)).digest('hex')}));
    return {
      articleId:article.id,title:field('title')||article.title,series:field('series'),status:field('status'),publisherStatus:field('publisher_status'),
      factStatus:field('fact_check_status')||field('fact_check'),visualStatus:field('visual_status'),
      bodyFingerprint:createHash('sha256').update(body).digest('hex'),assetFingerprint:createHash('sha256').update(JSON.stringify(assets)).digest('hex'),
      assetCount:assets.length,sourceRevision
    };
  });
}

/**
 * Materialize a Word/Google-Drive export into the Publisher's canonical
 * per-article contract. Text and inline images are consumed together; images
 * never become independent ContentItems. Output names are deterministic, so
 * rescanning the same revision is idempotent and a changed source refreshes it.
 */
export function ingestDocxContentBundle(
  sourceDocx: string,
  targetRoot: string,
  source: { driveFileId?: string; driveFolderId?: string; sourceUrl?: string; activeAssetOverrides?: Record<string, ActiveAssetOverride[]>; includeArticleIds?: string[] } = {}
): DocxIngestResult {
  const sourcePath = resolve(sourceDocx);
  if (!existsSync(sourcePath) || extname(sourcePath).toLowerCase() !== ".docx") throw new Error("DOCX 内容包不存在");
  const sourceBytes = readFileSync(sourcePath);
  const sourceRevision = createHash("sha256").update(sourceBytes).digest("hex");
  const documentXml = zipText(sourcePath, "word/document.xml");
  const relationships = parseRelationships(zipText(sourcePath, "word/_rels/document.xml.rels"));
  const articleIds=source.includeArticleIds?new Set(source.includeArticleIds):undefined;
  const articles = parseArticles(documentXml, relationships).filter(article=>!articleIds||articleIds.has(article.id));
  if (!articles.length) throw new Error("DOCX 中没有识别到 VBE 内容编号");

  const imported: DocxIngestResult["imported"] = [];
  for (const article of articles) {
    const target = join(resolve(targetRoot), article.id);
    mkdirSync(target, { recursive: true });
    const sections = publicSections(article.paragraphs);
    // Research/related-content references may carry an ID but are not article packages.
    // Skip those only when they contain neither a public body nor inline media.
    if (!sections.wechat && article.media.length === 0) continue;
    if (!sections.wechat) throw new Error(`${article.id} 缺少微信公众号公开母稿`);
    // Preserve the complete GPT-authored source (including alternate drafts,
    // platform variants, and editorial notes) as internal evidence. It is not
    // a public payload; only the explicitly selected platform copies below
    // are eligible for Publisher submission.
    writeFileSync(join(target, `${article.id}-source-full-text-internal.md`),
      `<!-- Internal source transcript. Never use as a publish payload. -->\n\n${article.paragraphs.join("\n\n")}\n`);
    const publicTitle = sections.wechat.match(/^#\s+(.+)$/mu)?.[1]?.trim() || article.title;
    article.title = publicTitle;
    const assetNames: string[] = [];
    const assetSources: Record<string, Record<string, unknown>> = {};
    let coverIndex = 0, bodyIndex = 0;
    const overrides=source.activeAssetOverrides?.[article.id];
    if(overrides&&overrides.length!==article.media.length)throw new Error(`${article.id} active asset mapping count does not match inline images`);
    article.media.forEach((media,mediaIndex) => {
      const suffix = normalizedImageExtension(media.path);
      const override=overrides?.[mediaIndex];
      const role=override?.role??media.role;
      const filename = override?.filename ?? (role === "cover"
        ? `${coverIndex++ ? `cover_${coverIndex}` : "cover"}_INGESTED${suffix}`
        : `body_${String(++bodyIndex).padStart(2, "0")}_INGESTED${suffix}`);
      const bytes = zipBytes(sourcePath, media.path);
      const destination = join(target, filename);
      writeFileSync(destination, bytes);
      assetNames.push(filename);
      assetSources[filename] = {
        role: role === "cover" ? "COVER" : "BODY_INFOGRAPHIC",
        sequence: override ? mediaIndex : role === "cover" ? coverIndex - 1 : bodyIndex,
        source_kind: override?.driveFileId ? "DRIVE_ACTIVE_ASSET_DOCX_READBACK" : "DOCX_INLINE",
        source_doc_id: source.driveFileId,
        source_filename: basename(sourcePath),
        source_modified_revision: sourceRevision,
        drive_file_id: override?.driveFileId,
        inline_object_id: override?.inlineObjectId,
        semantic_label: override?.semanticLabel,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    });
    const markerToAsset=new Map(article.media.map((media,index)=>[media.marker,assetNames[index]]));
    const wechat=sections.wechat.replace(/\[\[VB_INLINE_MEDIA:([^\]]+)\]\]/gu,(marker)=>{
      const filename=markerToAsset.get(marker);
      if(!filename)throw new Error(`${article.id} unresolved inline image marker in public copy`);
      const markerIndex=sections.wechat.indexOf(marker),following=sections.wechat.slice(markerIndex+marker.length);
      const alt=following.match(/(?:^|\n)(图\s*\d+\s*｜[^\n]+)/u)?.[1]?.trim()??filename;
      return `![${alt}](${filename})`;
    });
    const bodyWithoutDuplicateTitle = wechat.trim().replace(/^#\s+(.+)\n+/u, (heading, value: string) => value.trim() === article.title ? "" : heading);
    writeFileSync(join(target, `${article.id}-wechat-public.md`), `# ${article.title}\n\n${normalizeWechatHeadings(bodyWithoutDuplicateTitle.trim())}\n`);
    if (isPublicVariant(sections.facebook)) writeFileSync(join(target, `${article.id}-facebook-public.txt`), `${article.title}\n\n${sections.facebook.trim()}\n`);
    if (isPublicVariant(sections.linkedin)) writeFileSync(join(target, `${article.id}-linkedin-public.txt`), `${article.title}\n\n${sections.linkedin.trim()}\n`);
    if (isPublicVariant(sections.xiaohongshu)) writeFileSync(join(target, `${article.id}-xiaohongshu-public.txt`), `${sections.xiaohongshu.trim()}\n`);

    const manifestPath = join(target, "manifest.json");
    let previous: Record<string, unknown> = {};
    try { previous = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>; } catch { /* first import */ }
    const previousAssetSources = objectRecord(previous.asset_sources);
    const previousActiveAssets = Array.isArray(previous.active_assets) ? previous.active_assets.map(String) : [];
    // A DOCX refresh owns only the assets that a previous DOCX refresh wrote.
    // Preserve independently verified Drive/history assets instead of silently
    // replacing the whole canonical media set on every import.
    const preservedAssets = previousActiveAssets.filter(name => {
      const metadata = objectRecord(previousAssetSources[name]);
      return !["DOCX_INLINE", "DRIVE_ACTIVE_ASSET_DOCX_READBACK"].includes(String(metadata.source_kind ?? "").toUpperCase());
    });
    const preservedAssetSources = Object.fromEntries(Object.entries(previousAssetSources).filter(([name, value]) => {
      return preservedAssets.includes(name);
    }));
    const mergedAssets = [...new Set([...assetNames, ...preservedAssets])];
    const mergedAssetSources = { ...preservedAssetSources, ...assetSources };
    writeFileSync(manifestPath, JSON.stringify({
      ...previous,
      article_id: article.id,
      title: article.title,
      version: `docx-inline-${sourceRevision.slice(0, 16)}`,
      content_type: "image_text",
      source_doc_id: source.driveFileId ?? previous.source_doc_id,
      source_folder_id: source.driveFolderId ?? previous.source_folder_id,
      source_url: source.sourceUrl ?? previous.source_url,
      ingestion_contract: "drive-docx-inline-v1",
      source_filename: basename(sourcePath),
      source_revision: sourceRevision,
      canonical_source: "independent_rewrite_doc",
      // Extracting bytes proves ingestion only; it does not pass fact or pixel QA.
      qa_status: "PENDING_FACT_QA",
      visual_qa_status: "PENDING",
      // Content readiness is not publication authorization. A first import is
      // always unapproved; an explicit prior authorization is merely retained.
      publication_authorized: previous.publication_authorized === true,
      active_assets: mergedAssets,
      asset_sources: mergedAssetSources,
      blocking_issue: assetNames.length ? "FACT_AND_VISUAL_QA_PENDING_AFTER_INLINE_ASSET_INGEST" : ""
    }, null, 2) + "\n");
    imported.push({ articleId: article.id, title: article.title, assetCount: assetNames.length, target });
  }
  return { source: sourcePath, sourceRevision, imported };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseArticles(xml: string, relationships: Map<string, string>): Article[] {
  const articles: Article[] = [];
  const articlesById = new Map<string, Article>();
  let current: Article | undefined;
  for (const paragraph of xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? []) {
    const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match => decodeXml(match[1])).join("").trim();
    const id = text.match(/\b(VBE-\d{8}-\d{3})\b/i)?.[1]?.toUpperCase();
    if (id && (!current || current.id !== id)) {
      current = articlesById.get(id);
      if (!current) {
        current = { id, title: titleFromHeading(text, id), paragraphs: [], media: [] };
        articlesById.set(id, current);
        articles.push(current);
      }
    }
    if (!current) continue;
    if (text) {
      current.paragraphs.push(docxHeading(text, paragraph));
      const declaredTitle = text.match(/^title\s*[:：]\s*(.+)$/iu)?.[1]?.trim();
      if (declaredTitle) current.title = declaredTitle.replace(/^['"]|['"]$/g, "");
      if ((!current.title || current.title === current.id) && text.includes("｜")) current.title = titleFromHeading(text, current.id);
    }
    for (const match of paragraph.matchAll(/r:embed="([^"]+)"/g)) {
      const target = relationships.get(match[1]);
      if (target && !current.media.some(media => media.path === target)) {
      const context = current.paragraphs.slice(-3).join(" ");
      const explicitCover = /头图|COVER|插入文章首部/i.test(context) && !/正文|BODY/i.test(context);
      const marker=`[[VB_INLINE_MEDIA:${target}]]`;
      if(!current.media.some(media => media.path === target))current.media.push({ path: target, role: explicitCover && !current.media.some(media => media.role === "cover") ? "cover" : "body", marker });
      current.paragraphs.push(marker);
      }
    }
  }
  return articles;
}

function publicSections(paragraphs: string[]) {
  const text = paragraphs.join("\n");
  const draftIndex = paragraphs.findIndex(value => /^FULL_DRAFT_V1\s*[｜|]\s*VBE-\d{8}-\d{3}\s*$/iu.test(value.trim()));
  if (draftIndex >= 0) {
    const draft: string[] = [];
    for (const value of paragraphs.slice(draftIndex + 1)) {
      const line = value.trim();
      if (/^FULL_DRAFT_V1\s*[｜|]\s*VBE-\d{8}-\d{3}\s*$/iu.test(line) || /^QA\s*:/iu.test(line)) break;
      draft.push(value);
    }
    return { wechat: draft.join("\n").trim(), facebook: "", linkedin: "", xiaohongshu: "" };
  }
  const section = (start: RegExp, ends: RegExp[]) => {
    const match = start.exec(text); if (!match) return "";
    const rest = text.slice(match.index + match[0].length);
    const positions = ends.map(pattern => pattern.exec(rest)?.index).filter((value): value is number => value !== undefined);
    return rest.slice(0, positions.length ? Math.min(...positions) : undefined).trim();
  };
  const markdownSection = (start: RegExp, ends: RegExp[]) => section(start, ends);
  const platformEnd = [/^#{1,3}\s*Facebook(?:版|版本|适配)?\s*$/imu,/^#{1,3}\s*LinkedIn(?:版|版本|适配)?\s*$/imu,/^#{1,3}\s*小红书(?:版|版本|适配)?\s*$/mu,/^#{1,3}\s*(?:事实核查与来源|FACT\s*CHECK|SEO(?:\s*QA)?|VISUAL\s*SPEC)\s*$/imu,/^【(?:Facebook|LinkedIn|小红书|FACT_QA|INTERNAL_QA)[^】]*】$/mu];
  const canonicalStart = paragraphs.findIndex(value => /^【公开母稿[｜|]\s*微信公众号】$/u.test(value.trim()));
  let wechat = "";
  if (canonicalStart >= 0) {
    const derived = /^【(?:平台适配方向|Facebook适配|Facebook版本|LinkedIn适配|LinkedIn版本|小红书适配|小红书版本|正文高密度信息图规格|INTERNAL QA｜不得发布)】$/u;
    const placeholder = /^【正文高密度信息图】$/u;
    const publicBody: string[] = [];
    for (let index = canonicalStart + 1; index < paragraphs.length; index++) {
      const value = paragraphs[index].trim();
      if (derived.test(value) || placeholder.test(value)) break;
      // The canonical Doc may carry an internal asset manifest between the
      // article and platform variants. It is ingestion metadata, never copy.
      if (!/^(?:【VISUAL_ASSET_MANIFEST[^】]*】|active_assets\s*:)/iu.test(value)) publicBody.push(value);
    }
    const captionIndex = paragraphs.findIndex((value, index) => index > canonicalStart && /^图\s*\d+\s*｜/u.test(value.trim()));
    const captions: string[] = [];
    if (captionIndex >= 0) {
      const caption=paragraphs[captionIndex].trim();
      if(!publicBody.includes(caption)){
        captions.push(caption);
        const sourceLine = paragraphs[captionIndex + 1]?.trim();
        if (sourceLine && /^VietBridge\s+驻越经营实录｜原创管理工具$/u.test(sourceLine)) captions.push(sourceLine);
      }
    }
    wechat = [...publicBody, ...captions].filter(Boolean).join("\n\n").trim();
  } else {
    wechat = section(/【(?:(?:公开正文[｜|]\s*)?微信公众号母稿|公开母稿[｜|]\s*微信公众号)】\s*/u, [/【Facebook/u, /【FACT_QA/u, /【INTERNAL_QA/u]);
    if (!wechat) {
      // Recent Google Docs batches use Markdown-style platform headings rather
      // than the older 【微信公众号母稿】 wrapper. Select the explicit WeChat
      // section when present; otherwise a top-level "微信公众号母稿" heading
      // owns the following copy until the next platform/QA section.
      wechat = markdownSection(/^#{1,3}\s*(?:微信公众号(?:版本|版)|公众号版本)\s*$/mu, platformEnd);
      if (!wechat) wechat = markdownSection(/^#{1,3}\s*微信公众号母稿\s*$/mu, platformEnd);
    }
  }
  const markdownPlatform = (name: string, endNames: string[]) => {
    const start = new RegExp(`^#{1,3}\\s*${name}(?:版|版本|适配)?\\s*$`, "mu");
    const ends = endNames.map(value => new RegExp(`^#{1,3}\\s*${value}(?:版|版本|适配)?\\s*$`, "mu"));
    return section(start, [...ends,/^#{1,3}\s*(?:事实核查与来源|FACT\s*CHECK|SEO(?:\s*QA)?|VISUAL\s*SPEC)\s*$/imu,/^【(?:FACT_QA|INTERNAL_QA)[^】]*】$/mu]);
  };
  const facebook = section(/【Facebook(?:版本|适配)?】\s*/u, [/【LinkedIn(?:版本|适配)?】/u, /【小红书(?:版本|适配)?】/u, /【SEO(?:_QA)?】/u, /【FACT_QA/u]) || markdownPlatform("Facebook",["LinkedIn","小红书"]);
  const linkedin = section(/【LinkedIn(?:版本|适配)?】\s*/u, [/【小红书(?:版本|适配)?】/u, /【SEO(?:_QA)?】/u, /【FACT_QA/u]) || markdownPlatform("LinkedIn",["小红书"]);
  const xiaohongshu = section(/【小红书(?:版本|适配)?】\s*/u, [/【SEO(?:_QA)?】/u, /【FACT_QA/u]) || markdownPlatform("小红书",[]);
  return {
    wechat,
    facebook,
    linkedin,
    xiaohongshu
  };
}

function parseRelationships(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]+)\/?\s*>/g)) {
    const attrs = match[1];
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target && /(?:^|\/)media\//.test(target)) result.set(id, `word/${target.replace(/^\.\//, "")}`.replace("word/../", ""));
  }
  return result;
}

function titleFromHeading(text: string, id: string): string {
  const after = text.slice(text.toUpperCase().indexOf(id) + id.length).replace(/^[｜|\s:：-]+/u, "").trim();
  return after || id;
}
function zipText(path: string, entry: string): string { return zipBytes(path, entry).toString("utf8"); }
function zipBytes(path: string, entry: string): Buffer { return execFileSync("unzip", ["-p", path, entry], { maxBuffer: 64 * 1024 * 1024 }); }
function decodeXml(value: string): string { return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function normalizedImageExtension(path: string): string { const ext = extname(path).toLowerCase(); return [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png"; }
function isPublicVariant(value: string): boolean {
  return Boolean(value.trim()) && !/由母稿压缩|待生成|PENDING|不进入公开payload|保留一个真实经营冲突|场景化开头\s*\+|避免把政策稿压成/iu.test(value);
}
