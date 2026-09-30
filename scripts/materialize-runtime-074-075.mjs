import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const batchRoot = resolve(project, '../Content-Library/Drive-Batches/VBE-20260924-074-075');
const sourceTextPath = '/Users/a1-6/Documents/Codex/2026-07-24/referenced-chatgpt-conversation-this-is-untrusted/bridge/vbe-074-075-source/document-text.md';
const sourceDocId = '1P-dKo5CoVeDBvitzuUlKtQSKqBkXQFlhFnkg7yXEz6g';
const sourceFolderId = '1y9O4w5NL6lBBfqoBirpHvv0yZQsB3SKd';
const rejectedRoot = join(project, 'output/VB-CONTENT-PUBLISH-RUNTIME-20260924-074-075/rejected-media');

const assetSpecs = {
  'VBE-20260924-074': [
    ['VBE-20260924-074_COVER_V01.png', 'cover', '1sh7-UPEDYtqCOSQXcV3VJpEfKIk48mor', '封面：外资商业许可新规'],
    ['VBE-20260924-074_BODY_FACT_V01.png', 'body', '1IqVuvXr8LFcNtwj7DJxgMwcSjHlMVOsX', '法令涉及的零售、物流及电商许可范围'],
    ['VBE-20260924-074_BODY_FRAMEWORK_V01.png', 'body', '1JSapqI1uNmSlIxV1o8iVoCIrV8mN3vuU', 'License Stack五层许可判断框架'],
  ],
  'VBE-20260924-075': [
    ['VBE-20260924-075_COVER_V01.png', 'cover', '1WAU3PWRrYzb3RzoV1oLnIrulvFSon_YM', '封面：企业税务数据清理'],
    ['VBE-20260924-075_BODY_FACT_V01.png', 'body', '1C9qTqKVOPO7qfvVtsIbgMTg0fY8P0j5f', '94,991个税号终止处理的统计口径'],
    ['VBE-20260924-075_BODY_FRAMEWORK_V01.png', 'body', '1ujg7dhxfpu2k7ASJGWFgBAV7o6fjA-Ks', 'Tax Data Hygiene Map数据核对框架'],
    ['VBE-20260924-075_BODY_ACTION_V01.png', 'body', '1T6_YVUZurI9w6Wal3BF3F-2FyMrz0Cwr', '每月15分钟的税务数据核对清单'],
  ],
};

function parseParagraphs(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const paragraphs = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\[P\d+ \| .* \| NORMAL_TEXT\]$/u.test(lines[index])) continue;
    const value = lines[index + 1] ?? '';
    paragraphs.push(value === '⟦EMPTY PARAGRAPH⟧' ? '' : value);
  }
  return paragraphs;
}

function requiredField(paragraphs, prefix) {
  const line = paragraphs.find(value => value.startsWith(prefix));
  if (!line) throw new Error(`Canonical Doc missing ${prefix}`);
  return line.slice(prefix.length).trim().replace(/^"|"$/gu, '');
}

function section(paragraphs, start, end) {
  const begin = paragraphs.indexOf(start);
  if (begin < 0) throw new Error(`Canonical Doc missing section ${start}`);
  const stop = end.map(value => paragraphs.indexOf(value, begin + 1)).filter(index => index >= 0);
  const finish = stop.length ? Math.min(...stop) : paragraphs.length;
  return paragraphs.slice(begin + 1, finish).filter(Boolean);
}

function insertAfter(paragraphs, anchor, addition) {
  const index = paragraphs.findIndex(value => value.includes(anchor));
  if (index < 0) throw new Error(`Public body insertion anchor not found: ${anchor}`);
  paragraphs.splice(index + 1, 0, '', addition, '');
}

function digest(value) {
  return createHash('sha256').update(readFileSync(value)).digest('hex');
}

function buildPayload(articleId, title, paragraphs, specs) {
  const assetByKind = Object.fromEntries(specs.map(spec => [spec[0].match(/_(COVER|BODY_[A-Z]+)_/u)?.[1] ?? '', spec[0]]));
  const body = [...paragraphs];
  if (articleId.endsWith('-074')) {
    insertAfter(body, '342号法令明确列出需要商业许可证的若干活动', `![法令许可活动范围](${assetByKind.BODY_FACT})\n\n图01｜零售、部分物流与电商平台活动：上线前核对许可层级。\n资料来源：第342/2026/NĐ-CP号法令及越南政府法律信息；VietBridge整理。`);
    insertAfter(body, '第五层：许可与持续条件。IRC、ERC、Business License及专项许可是否覆盖现实业务？', `![License Stack五层判断框架](${assetByKind.BODY_FRAMEWORK})\n\n图02｜新业务许可判断拆成五层：主体、商品/服务、交易方式、市场准入、许可条件。\nVietBridge驻越经营实录｜原创管理工具。`);
  } else {
    insertAfter(body, '近72,000个其实是2025年及更早已经提交、今年集中处理的历史积压案件。', `![税号终止处理统计口径](${assetByKind.BODY_FACT})\n\n图01｜94,991个完成处理案例中，23,017个为2026年申请，其余近72,000个属于往年积压。\n资料来源：越南税务机关公开口径；VietBridge整理。`);
    insertAfter(body, 'Tax Data Hygiene Map', `![Tax Data Hygiene Map数据核对框架](${assetByKind.BODY_FRAMEWORK})\n\n图03｜把注册地址、负责人、经营状态、税务状态、申报与海关义务放在一张核对图中。\nVietBridge驻越经营实录｜原创管理工具。`);
    insertAfter(body, '第四，准备注销或重启业务时，才发现历史申报、税款、海关或其他义务还有尾巴没有处理。', `![每月15分钟税务数据核对清单](${assetByKind.BODY_ACTION})\n\n图02｜每月检查注册地址、负责人身份、税务状态与历史未结事项。\nVietBridge驻越经营实录｜原创管理工具。`);
  }
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'author: 驻越经营实录',
    `cover: ${assetByKind.COVER}`,
    '---',
    '',
    `# ${title}`,
    '',
    body.join('\n'),
    '',
  ].join('\n');
  return frontmatter;
}

const sourceParagraphs = parseParagraphs(readFileSync(sourceTextPath, 'utf8'));
const results = [];
for (const [articleId, specs] of Object.entries(assetSpecs)) {
  const start = sourceParagraphs.findIndex(value => value === `content_id: ${articleId}`);
  if (start < 0) throw new Error(`Canonical Doc missing ${articleId}`);
  const nextArticle = sourceParagraphs.findIndex((value, index) => index > start && /^content_id: VBE-/u.test(value));
  const end = nextArticle >= 0 ? nextArticle : sourceParagraphs.length;
  const article = sourceParagraphs.slice(start, end);
  const title = requiredField(article, 'title: ');
  const wechatParagraphs = section(article, '【公开母稿｜微信公众号】', ['【Facebook版本】']);
  const titleKey = value => String(value).replace(/[“”‘’"'`]/gu, '').replace(/\s+/gu, '').trim();
  if (wechatParagraphs[0] && titleKey(wechatParagraphs[0]) === titleKey(title)) wechatParagraphs.shift();
  const facebook = section(article, '【Facebook版本】', ['【LinkedIn版本】']).join('\n').trim();
  const linkedin = section(article, '【LinkedIn版本】', ['【小红书版本】']).join('\n').trim();
  const xiaohongshu = section(article, '【小红书版本】', ['【SEO_QA】', '【FACT_QA】', '【VISUAL_ASSET_MANIFEST｜内部字段】']).join('\n').trim();
  const articleDir = join(batchRoot, articleId);
  mkdirSync(articleDir, { recursive: true });
  const filenames = specs.map(spec => spec[0]);
  for (const filename of filenames) if (!existsSync(join(articleDir, filename))) throw new Error(`${articleId} missing source asset file ${filename}`);

  if (articleId.endsWith('-074')) {
    const misplaced = join(articleDir, 'VBE-20260924-074_BODY_ACTION_V01.png');
    if (existsSync(misplaced)) {
      mkdirSync(rejectedRoot, { recursive: true });
      const quarantined = join(rejectedRoot, 'VBE-20260924-074_BODY_ACTION_V01.png.misbound-to-075');
      if (!existsSync(quarantined)) renameSync(misplaced, quarantined);
    }
  }

  const wechatPath = join(articleDir, `${articleId}-wechat-public.md`);
  const bodyImageLabels = {
    'VBE-20260924-074': new Set(['BODY_FACT', 'BODY_FRAMEWORK']),
    'VBE-20260924-075': new Set(['BODY_FACT', 'BODY_FRAMEWORK', 'BODY_ACTION']),
  }[articleId];
  const bodySpecs = specs.filter(spec => spec[1] === 'body');
  const wechat = buildPayload(articleId, title, wechatParagraphs, specs);
  writeFileSync(wechatPath, wechat, 'utf8');
  writeFileSync(join(articleDir, `${articleId}-facebook-public.txt`), `${title}\n\n${facebook}\n`, 'utf8');
  writeFileSync(join(articleDir, `${articleId}-linkedin-public.txt`), `${title}\n\n${linkedin}\n`, 'utf8');
  writeFileSync(join(articleDir, `${articleId}-xiaohongshu-public.txt`), `${xiaohongshu}\n`, 'utf8');

  const assetSources = {};
  for (const [index, spec] of specs.entries()) {
    const [filename, role, driveFileId, semanticLabel] = spec;
    assetSources[filename] = {
      role: role === 'cover' ? 'COVER' : 'BODY_INFOGRAPHIC',
      sequence: index,
      source_kind: 'DRIVE_ACTIVE_ASSET',
      drive_file_id: driveFileId,
      source_doc_id: sourceDocId,
      source_folder_id: sourceFolderId,
      semantic_label: semanticLabel,
      visual_standard_version: 'VietBridge-Visual-QA-2026-09-24',
      sha256: digest(join(articleDir, filename)),
    };
  }
  const qaPass = articleId.endsWith('-075');
  const manifest = {
    article_id: articleId,
    title,
    version: 'drive-batch-20260924-v1',
    content_type: 'image_text',
    source_doc_id: sourceDocId,
    source_folder_id: sourceFolderId,
    source_url: `https://docs.google.com/document/d/${sourceDocId}/edit`,
    canonical_source: 'independent_rewrite_doc',
    ingestion_contract: 'drive-platform-payload-v1',
    source_revision: 'ANLCKQm7mFZ1Br9cmWmKQA2vGsCeFENF_SvW9CUuc37K1BCpzeulLlCuOBnK1cF262SHTiQnp_m4XChfHKzesu5rJPbRkkfI8f6iTaGJVeM_',
    qa_status: qaPass ? 'PASS' : 'FAIL',
    blocking_issue: qaPass ? undefined : 'VISUAL_ASSET_MISMATCH: 074_BODY_ACTION source image depicts 075 tax-data checklist; quarantined and excluded. Correct 074 action image is missing.',
    publication_authorized: false,
    active_assets: filenames,
    asset_sources: assetSources,
    platform_payloads: {
      wechat_official_account: `${articleId}-wechat-public.md`,
      facebook: `${articleId}-facebook-public.txt`,
      linkedin: `${articleId}-linkedin-public.txt`,
      xiaohongshu: `${articleId}-xiaohongshu-public.txt`,
    },
  };
  writeFileSync(join(articleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  results.push({ articleId, title, activeAssets: filenames, bodyImageCount: bodySpecs.length, qaStatus: manifest.qa_status, payloadSizes: { wechat: Buffer.byteLength(wechat), facebook: Buffer.byteLength(facebook), linkedin: Buffer.byteLength(linkedin), xiaohongshu: Buffer.byteLength(xiaohongshu) } });
}
console.log(JSON.stringify({ batchRoot, sourceDocId, results }, null, 2));
