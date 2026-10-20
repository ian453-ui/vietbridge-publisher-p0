export function renderWechatPreviewArticle(markdown, assets, imageUrl) {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
  function inlineHtml(value) {
    const text = String(value ?? '')
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<\/?(?:span|strong|em|b|i|u|small|sup|sub)\b[^>]*>/giu, '')
      .replace(/<[^>]*>/gu, '');
    return escapeHtml(text)
      .replace(/`([^`]+)`/gu, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/gu, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^\s)]+)\)/giu, (_match, label, href) =>
        /^https?:\/\//iu.test(href)
          ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
          : label);
  }
  const body = String(markdown ?? '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  const blocks = body.split(/\n\s*\n/u).map((block) => block.trim()).filter(Boolean);
  const expanded = blocks.flatMap((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.length >= 4 ? lines : [block];
  });
  const grouped = [];
  for (const block of expanded) {
    const current = String(block).trim();
    if (/^(?:[-*+]\s+|\d+[.)、]\s+)/u.test(current) && grouped.length
      && /^(?:[-*+]\s+|\d+[.)、]\s+)/u.test(grouped[grouped.length - 1])) {
      grouped[grouped.length - 1] += '\n' + current;
    } else grouped.push(current);
  }
  const html = [];
  const unplacedBodyImages = (assets ?? []).filter((asset) =>
    /^body[_-]/iu.test(String(asset.filename ?? ''))
    && !body.includes(String(asset.filename ?? '')));
  if (unplacedBodyImages.length) {
    html.push('<p class="preview-note error">原文图片已读到，但以下正文信息图没有出现在公众号正文中：'
      + unplacedBodyImages.map((asset) => escapeHtml(asset.filename)).join('、')
      + '。当前头图展示不能代替正文排版；请先修正公众号公开稿的图片位置。</p>');
  }
  for (const block of grouped) {
    const line = block.trim();
    const image = line.match(/^!\[([^\]]*)\]\(<?([^)>]+)>?\)$/u);
    if (image) {
      const source = image[2].split(/[?#]/u, 1)[0];
      const file = source.split('/').pop();
      const asset = (assets ?? []).find((item) => item.filename === file
        || String(item.path ?? '').endsWith('/' + file)
        || String(item.staging_path ?? '').endsWith('/' + file));
      html.push(asset
        ? '<figure><img src="' + escapeHtml(imageUrl(asset)) + '" alt="' + escapeHtml(image[1]) + '"></figure>'
        : '<p class="preview-note">正文图片尚未解析：' + escapeHtml(file) + '</p>');
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/u.test(line)) { html.push('<hr>'); continue; }
    const heading = line.match(/^(#{1,6})\s+([\s\S]+)$/u);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      html.push('<h' + level + '>' + inlineHtml(heading[2]) + '</h' + level + '>');
      continue;
    }
    if (/^【[^】]+】$/u.test(line)) {
      html.push('<h3 class="preview-label">' + inlineHtml(line.slice(1, -1)) + '</h3>');
      continue;
    }
    const lines = line.split('\n').map((item) => item.trim()).filter(Boolean);
    const listItems = lines.map((item) => item.match(/^(?:[-*+]\s+|\d+[.)、]\s+)(.*)$/u));
    if (lines.length && listItems.every(Boolean)) {
      const ordered = /^\d+[.)、]\s+/u.test(lines[0]);
      html.push('<' + (ordered ? 'ol' : 'ul') + '>' + listItems.map((item) => '<li>' + inlineHtml(item[1]) + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
      continue;
    }
    html.push('<p>' + inlineHtml(line).replace(/\n/g, '<br>') + '</p>');
  }
  return '<article class="preview-article">' + html.join('') + '</article>';
}
