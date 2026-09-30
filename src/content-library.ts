import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { SupportedPlatform } from "./platform-contract.ts";

export type ContentAsset = {
  assetId: string;
  contentId: string;
  path: string;
  filename: string;
  sourcePath: string;
  sourceDriveId?: string;
  sourceFolderId?: string;
  sourceDocId?: string;
  inlineObjectId?: string;
  sourceKind?: string;
  semanticLabel?: string;
  visualStandardVersion?: string;
  sourceModifiedTime: number;
  sizeBytes: number;
  sha256: string;
  revision: string;
  qaState: "PASS" | "FAIL" | "UNKNOWN";
  role: "cover" | "gallery_image" | "article_inline" | "video" | "video_cover" | "attachment";
  ordinal: number;
  sequence: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

const videoProbeCache=new Map<string,{durationSeconds?:number;width?:number;height?:number}>();
export function videoDetails(path:string,size:number,modified:number){
  const key=`${path}\0${size}\0${modified}`;
  const cached=videoProbeCache.get(key);if(cached)return cached;
  let details:{durationSeconds?:number;width?:number;height?:number}={};
  try{
    const raw=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height','-of','json',path],{encoding:'utf8',timeout:5000,maxBuffer:100000,stdio:['ignore','pipe','ignore']}));
    const stream=raw.streams?.find((s:Record<string,unknown>)=>Number(s.width)>0&&Number(s.height)>0);
    const duration=Number(raw.format?.duration);
    details={durationSeconds:Number.isFinite(duration)?duration:undefined,width:Number(stream?.width)||undefined,height:Number(stream?.height)||undefined};
  }catch{/* A missing probe never turns a real video into an image. */}
  videoProbeCache.set(key,details);return details;
}

export type ContentVariantPlatform = SupportedPlatform | "linkedin";

export type ContentPackage = {
  articleId: string;
  version: string;
  title: string;
  contentType: "video" | "image_text" | "other";
  packageRoot: string;
  assets: ContentAsset[];
  payloads: Partial<Record<ContentVariantPlatform, string>>;
  canonicalDocument: { contentId: string; driveFileId?: string; driveFolderId?: string; sourceAnchor?: string; sourceUrl?: string };
  variantAssets: Partial<Record<ContentVariantPlatform, string[]>>;
  readiness: "READY" | "BLOCKED";
  blockingReasons: string[];
  blockingDetail?: string;
  unresolvedAssets: string[];
  duplicateCandidates: number;
  publishedPlatforms: SupportedPlatform[];
  draftPlatforms?: SupportedPlatform[];
  sourceEvidence: string[];
  canonicalSource: boolean;
};

export type ResolveRequest = {
  mode: "ledger" | "article_id" | "local_path" | "url" | "search";
  value?: string;
  platforms?: SupportedPlatform[];
};

export type ResolveResult =
  | { status: "MATCHED"; package: ContentPackage; disabledPlatforms: SupportedPlatform[] }
  | { status: "CANDIDATES"; candidates: ContentPackage[]; reason: string }
  | { status: "NEEDS_SUPPLEMENT"; reason: string; matchedPath?: string }
  | { status: "REJECTED"; reason: string };

// VBE is the canonical identifier used by the Drive content-repair pipeline.
// Keep the legacy Daily/TT forms because historical packages remain valid.
const CONTENT_ID = /\b(VBE-\d{8}-\d{3}|Daily-\d{3}|TT-\d{8}-[A-Z]+-\d+|VIDEO-\d{3}-[A-Z0-9-]+)\b/i;
const MEDIA = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4"]);

export function clientPublicPayload(source: string): {body: string; title?: string} {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let metadata: Record<string, unknown> = {};
  if (frontmatter) {
    try { metadata = parseYaml(frontmatter[1]) ?? {}; } catch { return {body: ""}; }
  }
  const fallback = source.slice(frontmatter?.[0].length ?? 0).replace(/^#.*\n/, "").trim();
  const caption = typeof metadata.publish_caption === "string" ? metadata.publish_caption.trim() : "";
  const body = caption || fallback;
  const title = typeof metadata.publish_title === "string" ? metadata.publish_title.trim() : undefined;
  return {body: /Visual package only|Use the approved.*body|BODY_INFOGRAPHIC_PLACEHOLDER/i.test(body) ? "" : body, title};
}

export class ContentLibrary {
  readonly roots: string[];
  readonly ledgerPath?: string;

  constructor(options: { roots: string[]; ledgerPath?: string }) {
    this.roots = options.roots.filter(existsSync).map(path => realpathSync(resolve(path)));
    this.ledgerPath = options.ledgerPath;
  }

  index(): ContentPackage[] {
    const files = this.roots.flatMap(root => walk(root));
    const published = this.readPublishedPlatforms();
    const packages: ContentPackage[] = [];
    const claimed = new Set<string>();
    for(const manifestPath of files.filter(path=>basename(path)==='publisher-manifest.json'&&path.includes('/clients/'))){
      const root=dirname(manifestPath);
      let manifest:{status?:string;items?:Array<Record<string,unknown>>};
      try{manifest=JSON.parse(readFileSync(manifestPath,'utf8'));}catch{continue;}
      for(const entry of manifest.items??[]){
        const articleId=String(entry.content_id??'');
        if(!/^[A-Z][A-Z0-9-]{3,80}$/.test(articleId))continue;
        const document=join(root,'READY/content',articleId+'.md');
        if(!existsSync(document))continue;
        const source=readFileSync(document,'utf8');
        const {body,title}=clientPublicPayload(source);
        const hasPublicBody=Boolean(body);
        const publicDir=join(root,'.publisher-public'),publicPath=join(publicDir,articleId+'-facebook-public.txt');
        if(hasPublicBody){mkdirSync(publicDir,{recursive:true});if(!existsSync(publicPath)||readFileSync(publicPath,'utf8')!==body+'\n')writeFileSync(publicPath,body+'\n');}
        const media=(entry.primary_image?[entry.primary_image]:[entry.cover??entry.asset_cover_path,entry.infographic??entry.asset_infographic_path]).filter(Boolean).map(String);
        const safe=(name:string)=>{const path=resolve(root,name);return isWithin(path,root)&&existsSync(path)&&isWithin(realpathSync(path),realpathSync(root));};
        const unresolvedAssets=media.filter(name=>!safe(name));
        const assets=media.filter(safe).map((name,index)=>{
          const path=realpathSync(resolve(root,name)),stat=statSync(path),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
          return {assetId:stableAssetId(articleId,basename(path)),contentId:articleId,path,filename:basename(path),sourcePath:path,sourceModifiedTime:stat.mtimeMs,sizeBytes:stat.size,sha256,revision:sha256,qaState:'PASS' as const,role:index===0?'cover' as const:'gallery_image' as const,ordinal:index+1,sequence:index};
        });
        const blockingReasons=[...(manifest.status!=='READY'||entry.status!=='READY'?['PACKAGE_QA_FAILED']:[]),...(!hasPublicBody?['PUBLIC_PAYLOAD_MISSING']:[]),...(!assets.some(asset=>asset.role==='cover')?['COVER_MISSING']:[]),...(unresolvedAssets.length?['ASSET_REFERENCE_UNRESOLVED']:[])];
        const version='client-'+createHash('sha256').update(JSON.stringify([source,assets.map(asset=>asset.sha256),entry.status,manifest.status])).digest('hex').slice(0,12);
        packages.push({articleId,version,title:title||String(entry.title??articleId),contentType:'image_text',packageRoot:root,assets,payloads:hasPublicBody?{facebook:publicPath}:{},canonicalDocument:{contentId:articleId},variantAssets:{facebook:assets.map(asset=>asset.assetId)},readiness:blockingReasons.length?'BLOCKED':'READY',blockingReasons,blockingDetail:hasPublicBody?undefined:'客户资料包缺少已批准的 Facebook 正文',unresolvedAssets,duplicateCandidates:0,publishedPlatforms:published.get(articleId)??[],sourceEvidence:[manifestPath,document,...assets.map(a=>a.path)],canonicalSource:true});
        claimed.add(document);for(const asset of assets)claimed.add(asset.path);
      }
      claimed.add(manifestPath);
    }
    for (const manifestPath of files.filter(isManifestCandidate)) {
      if(claimed.has(manifestPath))continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { continue; }
      const rawId = String(raw.article_id ?? raw.item_id ?? raw.source_article ?? basename(manifestPath).match(CONTENT_ID)?.[1] ?? "");
      if (!rawId.match(CONTENT_ID)) continue;
      const articleId = canonicalId(rawId);
      const manifestDir = dirname(manifestPath);
      const packageDir = basename(manifestDir).toLowerCase() === "manifest" ? dirname(manifestDir) : manifestDir;
      const videoId = String(raw.video_id ?? "");
      const dedicatedPackage = basename(packageDir).includes(articleId) || (videoId && basename(packageDir).includes(videoId));
      const scope = files.filter(path => path === packageDir || isWithin(path, packageDir))
        .filter(path => dedicatedPackage || path === manifestPath || fileBelongsToContent(path,articleId));
      for (const path of scope) claimed.add(path);
      packages.push(buildPackage(articleId, scope, published.get(articleId) ?? []));
    }
    const groups = new Map<string, string[]>();
    for (const path of files) {
      if (claimed.has(path)) continue;
      const id = extractContentId(basename(path)) ?? extractContentId(path);
      if (!id) continue;
      const articleId = canonicalId(id);
      // Keep dedicated revision directories separate; never combine old MP4s
      // with the newest revision's caption just because article IDs match.
      let scope = dirname(path);
      while (!basename(scope).includes(articleId) && dirname(scope)!==scope && !this.roots.includes(scope)) scope=dirname(scope);
      const key = articleId + "|" + scope;
      const list = groups.get(key) ?? [];
      list.push(path);
      groups.set(key, list);
    }
    packages.push(...[...groups.entries()].map(([key, paths]) => {const articleId=key.split('|')[0];return buildPackage(articleId, paths, published.get(articleId) ?? []);}));
    const unique = new Map<string, ContentPackage>();
    for (const item of packages) unique.set(`${item.articleId}|${item.packageRoot}|${item.version}`, item);
    // Recognition and publishability are separate concerns. Keep complete
    // media packages in the index even when public copy is still missing, so
    // search/diagnostics can explain what must be supplied. Candidate filters
    // continue to hide variants that cannot be sent to the selected platform.
    const allIndexed=[...unique.values()].filter(item => Object.keys(item.payloads).length > 0 || item.assets.length > 0);
    const explicitCanonicalIds=new Set(allIndexed.filter(item=>item.canonicalSource).map(item=>item.articleId));
    // An explicitly declared independent rewrite is the sole consumer source.
    // Historical production/audit packages remain on disk as evidence but do
    // not become a second ContentItem for the same article.
    const indexed=allIndexed.filter(item=>item.canonicalSource||!explicitCanonicalIds.has(item.articleId));
    const counts=new Map<string,number>();for(const item of indexed)counts.set(item.articleId,(counts.get(item.articleId)||0)+1);
    for(const item of indexed){item.duplicateCandidates=(counts.get(item.articleId)||1)-1;if(item.articleId.startsWith('VBE-')&&item.duplicateCandidates>0){item.readiness='BLOCKED';item.blockingReasons.push('CANONICAL_ARTICLE_DUPLICATE');}}
    return indexed
      .sort((a, b) => b.articleId.localeCompare(a.articleId, undefined, { numeric: true }));
  }

  resolve(request: ResolveRequest): ResolveResult {
    const platforms = request.platforms ?? [];
    const items = this.index();
    if (request.mode === "ledger") {
      const match = items.find(item => platforms.some(platform => !item.publishedPlatforms.includes(platform))) ?? items[0];
      return match ? matched(match, platforms) : { status: "NEEDS_SUPPLEMENT", reason: "资源库中没有可发布内容" };
    }
    const value = request.value?.trim();
    if (!value) return { status: "REJECTED", reason: "请输入内容编号、关键词、路径或 Google Drive 链接" };
    if (request.mode === "url") {
      let url: URL;
      try { url = new URL(value); } catch { return { status: "REJECTED", reason: "URL 格式无效" }; }
      if (url.protocol === "file:") return this.resolve({ ...request, mode: "local_path", value: fileURLToPath(url) });
      if (url.protocol !== "https:" || !isGoogleDriveHost(url.hostname)) {
        return { status: "REJECTED", reason: "P0 仅接受本地文件、file:// 或 Google Drive 链接；其他公网 URL 不会自动下载" };
      }
      const fileId = googleDriveFileId(url);
      if (!fileId) return { status: "REJECTED", reason: "无法从 Google Drive 链接识别文件 ID" };
      const local = items.find(item => item.canonicalDocument.driveFileId===fileId||item.canonicalDocument.driveFolderId===fileId||item.sourceEvidence.some(path => path.includes(fileId)));
      return local ? matched(local, platforms) : { status: "NEEDS_SUPPLEMENT", reason: `已识别 Google Drive 文件 ${fileId}，但本地资源库尚未找到对应内容包；请先同步到本机或选择本地文件` };
    }
    if (request.mode === "local_path") {
      let real: string;
      try { real = realpathSync(resolve(value)); } catch { return { status: "REJECTED", reason: "本地路径不存在" }; }
      if (!this.roots.some(root => isWithin(real, root))) return { status: "REJECTED", reason: "路径不在允许的内容资源库内" };
      const exactOwners = items.filter(item => item.sourceEvidence.includes(real));
      if (exactOwners.length === 1) return matched(exactOwners[0], platforms);
      const id = basename(real).match(CONTENT_ID)?.[1] ?? real.match(CONTENT_ID)?.[1];
      if (id) {
        const item = items.find(candidate => candidate.articleId === canonicalId(id));
        if (item) return matched(item, platforms);
      }
      const exact = items.filter(item => item.sourceEvidence.includes(real));
      if (exact.length === 1) return matched(exact[0], platforms);
      return { status: "NEEDS_SUPPLEMENT", reason: "文件在资源库内，但无法唯一匹配完整内容包；需要临时补充标题、正文、封面与媒体顺序", matchedPath: real };
    }
    const exactId = items.filter(item => item.articleId.toLowerCase() === canonicalId(value).toLowerCase() || basename(item.packageRoot).toLowerCase().startsWith(canonicalId(value).toLowerCase() + '-'));
    if (request.mode === "article_id" || exactId.length === 1) {
      if (exactId.length === 1) return matched(exactId[0], platforms);
      if (exactId.length > 1) return { status: "CANDIDATES", candidates: exactId.slice(0, 20), reason: "同一内容编号有多个制作版本，请选择准确版本" };
      return { status: "NEEDS_SUPPLEMENT", reason: `未找到内容编号 ${value}` };
    }
    const needle = value.toLowerCase();
    const candidates = items.filter(item => `${item.articleId} ${item.title} ${item.sourceEvidence.map(path => basename(path)).join(" ")}`.toLowerCase().includes(needle)).slice(0, 20);
    if (!candidates.length) return { status: "NEEDS_SUPPLEMENT", reason: `资源库没有匹配“${value}”的内容` };
    return { status: "CANDIDATES", candidates, reason: "关键词搜索只显示候选，请明确选择后再执行" };
  }

  resolveBytes(data: Buffer, platforms: SupportedPlatform[] = []): ResolveResult {
    const target = createHash("sha256").update(data).digest("hex");
    const matches = this.index().filter(item => item.assets.some(asset => {
      try { return createHash("sha256").update(readFileSync(asset.path)).digest("hex") === target; }
      catch { return false; }
    }));
    if (matches.length === 1) return matched(matches[0], platforms);
    if (matches.length > 1) return { status: "CANDIDATES", candidates: matches, reason: "该文件存在于多个内容包，请选择正确内容" };
    return { status: "NEEDS_SUPPLEMENT", reason: "文件未在资源库中匹配；需要临时补充标题、正文、封面与媒体顺序" };
  }

  readPublishedPlatforms(): Map<string, SupportedPlatform[]> {
    const result = new Map<string, SupportedPlatform[]>();
    if (!this.ledgerPath || !existsSync(this.ledgerPath)) return result;
    const raw = readFileSync(this.ledgerPath, "utf8");
    try {
      // The shared append-only mirror contains a few historical duplicate YAML keys.
      // Read the last occurrence while keeping SQLite/platform readback authoritative.
      const doc = parseYaml(raw, { uniqueKeys: false }) as { published_history?: Record<string, Record<string, { status?: string }>> };
      for (const [id, record] of Object.entries(doc.published_history ?? {})) {
        const platforms: SupportedPlatform[] = [];
        if (isPublished(record.xiaohongshu?.status)) platforms.push("xiaohongshu");
        if (isPublished(record.facebook?.status)) platforms.push("facebook");
        if (isPublished(record.wechat_channels?.status) || isPublished(record.shipinhao?.status)) platforms.push("wechat_channels");
        if (isPublished(record.wechat?.status)) platforms.push("wechat_official_account");
        mergePlatforms(result, canonicalId(id), platforms);
      }
    } catch { /* malformed mirror must not be treated as publication authority */ }
    // The historical ledger has duplicate YAML keys and some video publication
    // evidence under resource_queue. Preserve every positive status instead of
    // allowing a later duplicate mapping to erase an earlier publication.
    for (const [id, platforms] of scanLedgerPublicationEvidence(raw)) mergePlatforms(result, id, platforms);
    const verifiedPath=resolve(dirname(this.ledgerPath),'verified-publications.jsonl');
    if(existsSync(verifiedPath))for(const line of readFileSync(verifiedPath,'utf8').split(/\r?\n/)){
      if(!line.trim())continue;try{
        const row=JSON.parse(line) as {article_id?:string;platform?:SupportedPlatform;status?:string;source?:string};
        if(!row.article_id||!row.platform)continue;
        const id=canonicalId(row.article_id),platforms=new Set(result.get(id)??[]);
        // Verified events are chronological corrections to the historical YAML
        // mirror. A deletion/private/withdrawn readback must revoke older positive
        // evidence instead of being swallowed by the previous union-only model.
        if(isPublished(row.status))platforms.add(row.platform);
        else if(isVerifiedUnpublished(row.status)&&!(row.platform==='wechat_official_account'&&row.status==='PLATFORM_DELETED'&&row.source==='publisher_independent_readback'))platforms.delete(row.platform);
        result.set(id,[...platforms]);
      }catch{/* preserve all earlier valid append-only evidence */}
    }
    return result;
  }
}

function buildPackage(articleId: string, paths: string[], publishedPlatforms: SupportedPlatform[]): ContentPackage {
  const sorted = [...new Set(paths)].sort();
  const manifests = sorted.filter(isManifestCandidate);
  let metadata: Record<string, unknown> = {};
  for (const path of manifests) {
    try { metadata = { ...metadata, ...JSON.parse(readFileSync(path, "utf8")) }; } catch { /* evidence remains visible */ }
  }
  const payloads: Partial<Record<ContentVariantPlatform, string>> = {};
  for (const path of sorted) {
    const name = basename(path).toLowerCase();
    if (/facebook-(?:video-)?public/.test(name) && isText(path)) payloads.facebook = path;
    else if (/xiaohongshu-(?:video-)?public/.test(name) && isText(path)) payloads.xiaohongshu = path;
    else if ((name.includes("wechat-channels-public") || name.includes("shipinhao-public") || name.includes("channels-public")) && isText(path)) payloads.wechat_channels = path;
    else if ((name.includes("wechat-public") || name.includes("wechat-video-companion-public") || name.includes("wechat-companion-public")) && isText(path)) payloads.wechat_official_account = path;
    else if (name.includes("linkedin-public") && isText(path)) payloads.linkedin = path;
    else if (isText(path) && /\/public-payloads\//i.test(path) && canonicalId(name) === articleId) {
      // New video batches deliberately share one approved short-form caption
      // across Facebook, Xiaohongshu and WeChat Channels. The manifest keeps
      // the item identity; the publisher must not require three copied files.
      payloads.facebook = path;
      payloads.xiaohongshu = path;
      payloads.wechat_channels = path;
    }
  }
  // Existing video packages predate a dedicated Channels caption file. The
  // approved Xiaohongshu public caption is the deterministic short-video
  // fallback; the worker still enforces Channels' 16-character title limit.
  if (!payloads.wechat_channels && payloads.xiaohongshu) payloads.wechat_channels = payloads.xiaohongshu;
  const qaManifest=String(metadata.qa_status||'').toUpperCase();
  const mediaSelection = selectPublishableMedia(sorted, metadata, qaManifest);
  const sourceFolderId=stringValue(metadata.source_folder_id),sourceDoc=normalizeSourceDocument(metadata.source_doc_id,metadata.source_doc_anchor),sourceDocId=sourceDoc.driveFileId;
  const declaredImageOrder=Array.isArray(metadata.active_assets)&&metadata.active_assets.length>0;
  const explicitManifestCover=mediaSelection.selected.find(path=>assetSourceMetadata(metadata,basename(path)).role==='cover');
  const filenameCover=mediaSelection.selected.find(path=>assetRole(path)==='cover');
  const bodyMain=mediaSelection.selected.find(path=>/^body[_-]main(?:[_-].*)?\.(?:png|jpe?g|webp)$/i.test(basename(path)));
  const numberedFirstPage=mediaSelection.selected.find(path=>bodySequence(basename(path))===1||/(?:^|[-_])p(?:age)?0?1(?:[-_.]|$)/i.test(basename(path)));
  // A declared active_assets list is an ordered public package. When no
  // cover is explicitly identified, its first image is the cover; sorting
  // filenames must not silently promote BODY_* over FRONTLOAD_*.
  const declaredFirstImage=declaredImageOrder?mediaSelection.selected.find(path=>['.png','.jpg','.jpeg','.webp'].includes(extname(path).toLowerCase())):undefined;
  const canonicalCoverPath=explicitManifestCover??filenameCover??bodyMain??numberedFirstPage??declaredFirstImage??selectCanonicalCover(mediaSelection.selected,qaManifest);
  const explicitBodySequences=mediaSelection.selected.map(path=>bodySequence(basename(path))).filter((value):value is number=>value!==undefined);
  let nextFallbackSequence=Math.max(0,...explicitBodySequences)+1;
  const assets = mediaSelection.selected.map(path=>{
    const filename=basename(path),sourceMetadata=assetSourceMetadata(metadata,filename),detectedRole=sourceMetadata.role??assetRole(path),role=path===canonicalCoverPath?'cover':detectedRole==='cover'?'gallery_image':detectedRole,sequence=role==='cover'?0:sourceMetadata.sequence??bodySequence(filename)??nextFallbackSequence++;
    const explicitQaStatus=String(metadata.qa_status??'').trim().length>0;
    // An explicit manifest status is authoritative. In particular, an imported
    // file named *_QA_PASS must not override PENDING_FACT_QA or pending visual QA.
    const qaState:"PASS"|"FAIL"|"UNKNOWN"=qaManifest==='FAIL'? 'FAIL'
      : qaManifest==='PASS'? 'PASS'
      : explicitQaStatus? 'UNKNOWN'
      : /QA_PASS/i.test(filename)? 'PASS'
      : /BLOCKED|QA_FAIL/i.test(filename)? 'FAIL'
      : 'UNKNOWN';
    const stat=statSync(path),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
    const sourceDriveId=sourceMetadata.driveFileId;
    return {assetId:stableAssetId(articleId,filename),contentId:articleId,path,filename,sourcePath:path,sourceDriveId,sourceFolderId,
      sourceDocId:sourceMetadata.sourceDocId,inlineObjectId:sourceMetadata.inlineObjectId,sourceKind:sourceMetadata.sourceKind,
      semanticLabel:sourceMetadata.semanticLabel,visualStandardVersion:sourceMetadata.visualStandardVersion,
      sourceModifiedTime:stat.mtimeMs,sizeBytes:stat.size,sha256,revision:sha256,qaState,role,ordinal:sequence+1,sequence,
      ...(role==='video'?videoDetails(path,stat.size,stat.mtimeMs):{})} as ContentAsset;
  }).sort((a,b)=>roleRank(a.role)-roleRank(b.role)||a.sequence-b.sequence||a.filename.localeCompare(b.filename,undefined,{numeric:true}));
  assets.forEach((asset,index)=>{asset.ordinal=index+1;});
  if (assets.some(asset=>asset.role==='video')) {
    // The operator's task confirmation authorizes video delivery. Production
    // publication_permission is not a permanent library readiness gate.
    let caption = payloads.facebook ?? payloads.xiaohongshu ?? payloads.wechat_channels;
    if (!caption) {
      const script = manifests.map(path=>resolve(dirname(path),String(metadata.script??'')))
        .find(path=>Boolean(metadata.script)&&sorted.includes(path)&&isText(path));
      const opening = script ? readFileSync(script,'utf8').split(/\r?\n/).find(line=>line.trim())?.trim() : '';
      const label = String(metadata.title??'').trim() || opening?.split(/(?<=[。！？])/u)[0]?.trim();
      if (label) {
        const dir=join(commonDirectory(sorted),'.publisher-captions');mkdirSync(dir,{recursive:true});
        caption=join(dir,`${articleId}-video-public.txt`);
        const text=`${label}\n\n${opening || label}\n`;
        // This is only a bootstrap fallback. A human-edited public caption is
        // authoritative and must not be reset on each library scan.
        if(!existsSync(caption))writeFileSync(caption,text);
      }
    }
    if(caption)for(const platform of ['facebook','xiaohongshu','wechat_channels'] as const)payloads[platform]??=caption;
  }
  const metadataTitle = normalizePublicTitle(String(metadata.title ?? ""));
  const payloadTitle = titleFromPayload(payloads.xiaohongshu ?? payloads.facebook ?? payloads.wechat_official_account);
  const title = (isPlaceholderTitle(metadataTitle) ? (payloadTitle || metadataTitle) : (metadataTitle || payloadTitle)) || articleId;
  const packageRoot = commonDirectory(sorted);
  const version = String(metadata.media_revision ?? metadata.version ?? metadata.fact_core_version ?? metadata.fact_check_date ?? "library-current");
  const contentType = assets.some(asset => asset.role === "video") ? "video" : assets.some(asset => asset.role === "gallery_image" || asset.role === "cover") ? "image_text" : "other";
  const blockingReasons:string[]=[];
  // A single QA-passed body image can be promoted to the canonical cover by
  // legacy compatibility. It still resolves the placement instruction.
  const hasResolvedPlacementImage=assets.some(asset=>asset.role==='cover'||asset.role==='gallery_image');
  const publicPayloadLeaks = Object.entries(payloads).flatMap(([platform, path]) =>
    path ? publicPayloadInternalMarkers(path,hasResolvedPlacementImage).map(marker => `${platform}:${basename(path)}:${marker}`) : []
  );
  // VBE production packages promise a Drive canonical document. Historical
  // Daily/TT packages predate that contract and their approved public payload
  // remains the canonical local document for backward compatibility.
  if(articleId.startsWith('VBE-')&&!sourceDocId)blockingReasons.push('CANONICAL_DOCUMENT_MISSING');
  if(metadata.publication_permission===false&&contentType!=='video')blockingReasons.push('APPROVAL_REQUIRED');
  if(Object.keys(payloads).length===0)blockingReasons.push('PUBLIC_PAYLOAD_MISSING');
  if(articleId.startsWith('VBE-')&&qaManifest==='PENDING_FACT_QA')blockingReasons.push('FACT_QA_PENDING');
  // Production has explicitly marked these packages as awaiting the public
  // article and layout. Resolved media alone must not turn them READY.
  if(String(metadata.library_status??'')==='ASSET_INGESTED_PUBLIC_PAYLOAD_PENDING')blockingReasons.push('CONTENT_QA_PENDING');
  if(articleId.startsWith('VBE-')&&contentType==='image_text'&&!hasVerifiedVisualQa(metadata,manifests))blockingReasons.push('VISUAL_QA_PENDING');
  if(publicPayloadLeaks.length)blockingReasons.push('PUBLIC_PAYLOAD_INTERNAL_LEAK');
  if(qaManifest==='FAIL')blockingReasons.push('PACKAGE_QA_FAILED');
  else {
    // A QA-passed body infographic is a valid hero fallback. Some historical
    // Google Docs intentionally contain one high-density main image and no
    // separate cover file; blocking those packages caused the Publisher to
    // report missing media even though the consumer could resolve it.
    if(contentType!=='video'&&!assets.some(asset=>asset.role==='cover'||asset.role==='gallery_image'))blockingReasons.push('COVER_MISSING');
    if(mediaSelection.unresolved.length)blockingReasons.push('ASSET_REFERENCE_UNRESOLVED');
  }
  const imageIds=assets.filter(a=>a.role==='cover'||a.role==='gallery_image').map(a=>a.assetId);
  const variantAssets:Partial<Record<ContentVariantPlatform,string[]>>={};
  for(const platform of Object.keys(payloads) as ContentVariantPlatform[])variantAssets[platform]=[...imageIds];
  const manifestDetail=localizeBlockingDetail(stringValue(metadata.blocking_issue));
  const blockingDetail=publicPayloadLeaks.length
    ? `公开载荷含内部制作标记：${publicPayloadLeaks.join('；')}`
    : blockingReasons.includes('FACT_QA_PENDING')
      ? '文章事实核查尚未完成；图片导入或视觉检查不能替代主张—来源核验。'
    : blockingReasons.includes('VISUAL_QA_PENDING')
      ? '素材文件存在或文件名带 QA_PASS，不代表图中文字、信息密度、来源、手机可读性与正文位置已通过视觉验收。'
      : manifestDetail;
  return {articleId,version,title,contentType,packageRoot,assets,payloads,canonicalDocument:{contentId:articleId,driveFileId:sourceDocId,driveFolderId:sourceFolderId,sourceAnchor:sourceDoc.sourceAnchor,sourceUrl:stringValue(metadata.source_url)},variantAssets,readiness:blockingReasons.length?'BLOCKED':'READY',blockingReasons,blockingDetail,unresolvedAssets:qaManifest==='FAIL'?[]:mediaSelection.unresolved,duplicateCandidates:0,publishedPlatforms,sourceEvidence:sorted,canonicalSource:String(metadata.canonical_source??'')==='independent_rewrite_doc'};
}

function hasVerifiedVisualQa(metadata:Record<string,unknown>,manifests:string[]):boolean{
  const status=String(metadata.visual_qa_status??'').toUpperCase();
  if(status==='USER_CONFIRMED')return Boolean(String(metadata.visual_qa_evidence??'').trim());
  if(status!=='PASS')return false;
  const reportName=String(metadata.visual_density_report??'').trim();
  if(!reportName||reportName.includes('/')||reportName.includes('\\'))return false;
  for(const manifest of manifests){
    const reportPath=join(dirname(manifest),reportName);
    if(!existsSync(reportPath))continue;
    try{
      const report=JSON.parse(readFileSync(reportPath,'utf8')) as Record<string,unknown>;
      const metrics=report.metrics&&typeof report.metrics==='object'?report.metrics as Record<string,unknown>:{};
      const score=Number(metrics.information_quality_score??report.information_quality_score??0);
      if(String(report.status??'').toUpperCase()==='PASS'&&score>=85&&Array.isArray(report.failures)&&report.failures.length===0)return true;
    }catch{/* malformed quality evidence is not a pass */}
  }
  return false;
}

function normalizeSourceDocument(raw:unknown,declaredAnchor:unknown):{driveFileId?:string;sourceAnchor?:string}{
  const value=stringValue(raw),explicit=stringValue(declaredAnchor);
  if(!value)return {sourceAnchor:explicit};
  // Older batch imports incorrectly stored "DriveId#content_id" as one ID.
  // Split it at ingestion so existing packages recover immediately while the
  // manifest migration and all future imports use separate fields.
  const [driveFileId,legacyAnchor]=value.split('#',2);
  return {driveFileId:stringValue(driveFileId),sourceAnchor:explicit??stringValue(legacyAnchor)};
}

function publicPayloadInternalMarkers(path:string,hasResolvedBodyImage=false):string[]{
  let text="";try{text=readFileSync(path,"utf8");}catch{return ["PAYLOAD_UNREADABLE"];}
  const patterns:Array<[string,RegExp]>=[
    ["BODY_INFOGRAPHIC_QA_MARKER",/【正文高密度信息主图(?:｜[^】]+)?】/u],
    ["BODY_INFOGRAPHIC_PLACEHOLDER",/【正文高密度信息图】/u],
    ["BODY_INFOGRAPHIC_SPEC",/【正文高密度信息图规格】/u],
    ["PLATFORM_ADAPTATION_SECTION",/【(?:平台适配方向|Facebook适配|Facebook版本|小红书适配|小红书版本)】/u],
    ["TRAINING_CONVERSION_INTERNAL_HEADING",/【培训转化钩子】/u],
    ["FACT_QA_INTERNAL_SECTION",/(?:【(?:FACT_QA|INTERNAL[_ ]QA)[^】]*】|\b(?:FACT_QA|ASSET_QA|PUBLISHER_QA|FINAL_STATUS)\s*:)/iu],
    ["VISUAL_ASSET_MANIFEST_INTERNAL",/(?:【VISUAL_ASSET_MANIFEST[^】]*】|^\s*active_assets\s*:)/imu],
    ["CANONICAL_METADATA_TEXT",/^\s*(?:schema_version|content_id|storyline_id|narrative_mode)\s*:/imu],
    ["EDITORIAL_WORKFLOW_MARKER",/(?:修改记录|审核意见|返修单|READY_FOR_USER_APPROVAL|EDITORIAL_REVIEW|REVISION_REQUIRED)/u]
  ];
  const autoResolvedPlacementMarkers=new Set(["BODY_INFOGRAPHIC_QA_MARKER","BODY_INFOGRAPHIC_PLACEHOLDER"]);
  return patterns.filter(([label,pattern])=>pattern.test(text)&&!(hasResolvedBodyImage&&autoResolvedPlacementMarkers.has(label))).map(([label])=>label);
}

function isManifestCandidate(path:string):boolean {
  if(extname(path).toLowerCase()!=='.json')return false;
  const name=basename(path).toLowerCase();
  // Named manifests and item manifests are both production contracts. JSON
  // files outside a manifest directory are not scanned unless explicitly
  // named as a manifest, preventing arbitrary app/config JSON from becoming
  // content.
  return name.includes('manifest')||basename(dirname(path)).toLowerCase()==='manifest';
}
function fileBelongsToContent(path:string,articleId:string):boolean {
  const name=basename(path).toUpperCase();
  const id=articleId.toUpperCase();
  return name===id||name.startsWith(id+'.')||name.startsWith(id+'-')||name.startsWith(id+'_');
}

function selectPublishableMedia(paths: string[], metadata: Record<string, unknown> = {}, qaManifest = ""): {selected:string[];unresolved:string[]} {
  const media = paths.filter(path => MEDIA.has(extname(path).toLowerCase()));
  const declared = Array.isArray(metadata.active_assets) ? metadata.active_assets.map(String) : [];
  if (declared.length) {
    const byName = new Map(media.map(path => [basename(path), path]));
    const selected = declared.map(name => byName.get(name)).filter((path): path is string => Boolean(path));
    // QA blockers use a synthetic BLOCKED_* marker to exclude stale assets
    // from publication. Show the real sibling images for diagnosis, but keep
    // the package blocked by PACKAGE_QA_FAILED and mark every asset as failed.
    if (qaManifest === "FAIL" && declared.every(name => /^BLOCKED_/i.test(name))) {
      return {selected:media.filter(path => !/contact-sheet|\/review\/|\/frames\//i.test(path)),unresolved:[]};
    }
    // Fail closed when a manifest references an absent asset; never silently
    // substitute an obsolete revision from the same directory.
    return {selected,unresolved:declared.filter(name=>!byName.has(name))};
  }
  const finalVideos = media.filter(path => extname(path).toLowerCase() === ".mp4" && /\/final\//.test(path));
  if (finalVideos.length) {
    const mainCover = media.find(path => /\/covers?\/[^/]+-cover\.(png|jpe?g|webp)$/i.test(path));
    return {selected:[...(mainCover ? [mainCover] : []), ...finalVideos],unresolved:[]};
  }
  const posters = media.filter(path => /knowledge-poster/i.test(basename(path)) && !/contact-sheet|thumbnail/i.test(basename(path)));
  return {selected:posters.length ? posters : media.filter(path => !/contact-sheet|\/review\/|\/frames\//i.test(path)),unresolved:[]};
}

function matched(item: ContentPackage, requested: SupportedPlatform[]): ResolveResult {
  return { status: "MATCHED", package: item, disabledPlatforms: requested.filter(platform => item.publishedPlatforms.includes(platform)) };
}
function walk(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(realpathSync(path));
  }
  return output;
}
function canonicalId(value: string): string {
  const match = extractContentId(value) ?? value;
  return /^daily-/i.test(match) ? `Daily-${match.split("-")[1]}` : match.toUpperCase();
}
function extractContentId(value:string):string|undefined {
  const video=value.match(/\b(VIDEO-\d{3}-.+?)(?=-(?:final|cover|\d+x\d+|\d+(?:\.\d+)?|contact)(?:\.|-|$)|\.(?:md|txt|mp4|png|jpe?g|webp|srt|wav|json)|$)/i)?.[1];
  return video??value.match(/\b(VBE-\d{8}-\d{3}|Daily-\d{3}|TT-\d{8}-[A-Z]+-\d+)\b/i)?.[1];
}
function isWithin(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".."); }
function isGoogleDriveHost(host: string): boolean { return host === "drive.google.com" || host === "docs.google.com"; }
function googleDriveFileId(url: URL): string | undefined { return url.pathname.match(/\/(?:d|folders)\/([A-Za-z0-9_-]+)/)?.[1] ?? url.searchParams.get("id") ?? undefined; }
function isPublished(status?: string): boolean { return ["PUBLISHED", "PUBLISHED_ID_PENDING"].includes(status ?? ""); }
function isVerifiedUnpublished(status?:string):boolean{return ["PLATFORM_DELETED","NOT_PUBLISHED","PRIVATE","ONLY_ME","LOW_QUALITY_WITHDRAWN"].includes(status??"");}
function isText(path: string): boolean { return [".txt", ".md"].includes(extname(path).toLowerCase()); }
function assetRole(path: string): ContentAsset["role"] {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".mp4")) return "video";
  if (/(?:^|[-_])cover(?:[-_.]|$)/i.test(name)) return "cover";
  if (/^body[_-]\d+/i.test(name)) return "gallery_image";
  if (MEDIA.has(extname(name))) return "gallery_image";
  return "attachment";
}
function selectCanonicalCover(paths:string[],qaManifest:string):string|undefined{
  const images=paths.filter(path=>[".png",".jpg",".jpeg",".webp"].includes(extname(path).toLowerCase()));
  if(!images.length)return undefined;
  const explicit=images.filter(path=>assetRole(path)==='cover').sort((a,b)=>basename(a).localeCompare(basename(b),undefined,{numeric:true}));
  if(explicit.length)return explicit[0];
  const bodyMain=images.find(path=>/^body[_-]main(?:[_-].*)?\.(?:png|jpe?g|webp)$/i.test(basename(path)));
  if(bodyMain)return bodyMain;
  const firstPage=images.find(path=>/(?:^|[-_])p(?:age)?0?1(?:[-_.]|$)/i.test(basename(path))||/(?:^|[-_])01(?:[-_.]|$)/i.test(basename(path)));
  if(firstPage)return firstPage;
  return [...images].sort((a,b)=>basename(a).localeCompare(basename(b),undefined,{numeric:true}))[0];
}
function bodySequence(filename:string):number|undefined{const match=filename.match(/^body[_-](\d+)/i);return match?Number(match[1]):undefined;}
function localizeBlockingDetail(value:string|undefined):string|undefined{
  if(!value)return undefined;
  const terms:Record<string,string>={
    'rolling-budget management':'滚动预算管理','EHS article':'EHS 文章',
    'EHS compliance':'EHS 合规','logistics KPI article':'物流 KPI 文章',
    'logistics reliability':'物流可靠性','manufacturing quality-system article':'制造业质量系统文章',
    'quality-system capacity':'质量系统承载力','China-Vietnam inventory article':'中越双节点库存文章'
  };
  const match=value.match(/^visual assets depict (.+), not the (.+)$/i);
  if(match)return `现有图片主题为“${terms[match[1]]||match[1]}”，与“${terms[match[2]]||match[2]}”不一致；请替换正确图片包并重新质检。`;
  return value;
}
function stableAssetId(contentId:string,filename:string):string{return createHash('sha256').update(contentId+'\0'+filename.toLowerCase()).digest('hex');}
function assetDriveId(metadata:Record<string,unknown>,filename:string):string|undefined{
  return assetSourceMetadata(metadata,filename).driveFileId;
}
function assetSourceMetadata(metadata:Record<string,unknown>,filename:string):{driveFileId?:string;sourceDocId?:string;inlineObjectId?:string;sourceKind?:string;semanticLabel?:string;visualStandardVersion?:string;role?:ContentAsset['role'];sequence?:number}{
  const maps=[metadata.asset_drive_ids,metadata.asset_sources];
  for(const candidate of maps){
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))continue;
    const value=(candidate as Record<string,unknown>)[filename];
    if(typeof value==='string'&&value.trim())return {driveFileId:value.trim()};
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      const record=value as Record<string,unknown>;
      const declaredRole=String(record.role??'').toUpperCase();
      const rawSequence=Number(record.sequence);
      return {
        driveFileId:stringValue(record.drive_file_id??record.file_id),
        sourceDocId:stringValue(record.source_doc_id),inlineObjectId:stringValue(record.inline_object_id),
        sourceKind:stringValue(record.source_kind),semanticLabel:stringValue(record.semantic_label),
        visualStandardVersion:stringValue(record.visual_standard_version),
        role:declaredRole==='BODY_INFOGRAPHIC'||declaredRole==='GALLERY_IMAGE'?'gallery_image':declaredRole==='COVER'?'cover':undefined,
        sequence:Number.isFinite(rawSequence)?rawSequence:undefined
      };
    }
  }
  return {};
}
function stringValue(value:unknown):string|undefined{const text=String(value??'').trim();return text||undefined;}
function roleRank(role: ContentAsset["role"]): number { return ({ cover: 0, video_cover: 1, gallery_image: 2, article_inline: 3, video: 4, attachment: 5 })[role]; }
function titleFromPayload(path?: string): string | undefined {
  if (!path) return undefined;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map(x => x.trim());
  const frontmatterTitle = lines.find(line => /^(?:title|标题)\s*[:：]\s*\S/iu.test(line));
  if (frontmatterTitle) return normalizePublicTitle(frontmatterTitle).slice(0, 120);
  const heading = lines.find(line => /^#{1,6}\s+\S/u.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, "").slice(0, 120);
  const line = lines.find(x => x && x !== "---" && !x.startsWith("#"));
  return line?.slice(0, 120);
}
function normalizePublicTitle(value: string): string {
  return value.replace(/^(?:title|标题)\s*[:：]\s*/iu, "").trim();
}
function isPlaceholderTitle(value: string): boolean {
  return !value || /^(?:TT-\d{8}-[A-Z]+-\d+|Daily-?\d+)$/iu.test(value);
}

function mergePlatforms(target: Map<string, SupportedPlatform[]>, id: string, platforms: SupportedPlatform[]): void {
  target.set(id, [...new Set([...(target.get(id) ?? []), ...platforms])]);
}

function scanLedgerPublicationEvidence(raw: string): Map<string, SupportedPlatform[]> {
  const result = new Map<string, SupportedPlatform[]>();
  let section = "";
  let entryKey = "";
  let articleId = "";
  let platform: SupportedPlatform | "" = "";
  const flush = () => {
    if (!entryKey) return;
    const id = articleId.match(CONTENT_ID)?.[1] ?? entryKey.match(CONTENT_ID)?.[1];
    if (!id) return;
    const held = pending.get(entryKey) ?? [];
    mergePlatforms(result, canonicalId(id), held);
  };
  const pending = new Map<string, SupportedPlatform[]>();
  for (const line of raw.split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z_][\w-]*):\s*$/);
    if (top) { flush(); section = top[1]; entryKey = ""; articleId = ""; platform = ""; continue; }
    if (!['published_history', 'resource_queue'].includes(section)) continue;
    const entry = line.match(/^ {2}(\S[^:]*):(?:\s*(\{.*))?$/);
    if (entry) {
      flush(); entryKey = entry[1].trim(); articleId = ""; platform = ""; if (!pending.has(entryKey)) pending.set(entryKey, []);
      const inline = entry[2] ?? "";
      for (const [key, mapped] of [["facebook", "facebook"], ["xiaohongshu", "xiaohongshu"], ["wechat", "wechat_official_account"], ["wechat_channels", "wechat_channels"], ["shipinhao", "wechat_channels"]] as const) {
        if (new RegExp(`${key}:\\s*\\{[^}]*status:\\s*(?:PUBLISHED|PUBLISHED_ID_PENDING|DRAFT_API_WRITTEN_NOT_PUBLISHED)`, "u").test(inline)) mergePending(pending, entryKey, mapped);
      }
      continue;
    }
    if (!entryKey) continue;
    const idMatch = line.match(/^    article_id:\s*["']?([^"'#]+)["']?/);
    if (idMatch) articleId = idMatch[1].trim();
    const platformMatch = line.match(/^    (facebook|xiaohongshu|wechat|wechat_channels|shipinhao):\s*(.*)$/);
    if (platformMatch) {
      platform = ledgerPlatform(platformMatch[1]);
      if (platform && /status:\s*(PUBLISHED|PUBLISHED_ID_PENDING|DRAFT_API_WRITTEN_NOT_PUBLISHED)/u.test(platformMatch[2])) {
        mergePending(pending, entryKey, platform);
      }
      continue;
    }
    if (platform && /^      (?:status|prior_revision_status|current_revision_status|companion_article_status):\s*(PUBLISHED|PUBLISHED_ID_PENDING|DRAFT_API_WRITTEN_NOT_PUBLISHED)\s*$/u.test(line)) mergePending(pending, entryKey, platform);
    // A sent request is not safely retryable just because an old writer labelled it FAILED.
    if (platform && /^      live_request_sent_for_current_revision:\s*true\s*$/u.test(line)) mergePending(pending, entryKey, platform);
  }
  flush();
  return result;
}
function ledgerPlatform(value: string): SupportedPlatform | "" {
  if (value === "shipinhao" || value === "wechat_channels") return "wechat_channels";
  if (value === "wechat") return "wechat_official_account";
  if (value === "facebook" || value === "xiaohongshu") return value;
  return "";
}
function mergePending(target: Map<string, SupportedPlatform[]>, key: string, platform: SupportedPlatform): void {
  target.set(key, [...new Set([...(target.get(key) ?? []), platform])]);
}
function commonDirectory(paths: string[]): string {
  if (!paths.length) return "";
  let current = dirname(paths[0]);
  while (!paths.every(path => isWithin(path, current))) current = dirname(current);
  return current;
}
