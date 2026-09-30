/** Convert only unambiguous editorial headings into Markdown structure. */
export const VIETBRIDGE_WECHAT_HEADING_COLOR = '#1B3658';

export function validWechatHeadingColor(value: unknown): string {
  const color = String(value ?? VIETBRIDGE_WECHAT_HEADING_COLOR).trim();
  if (!/^#[0-9a-fA-F]{6}$/u.test(color)) throw new Error('公众号标题颜色必须是六位十六进制色值');
  return color.toUpperCase();
}

export function colorWechatHeadings(body: string, color: string): string {
  const safeColor = validWechatHeadingColor(color);
  return body.split(/\r?\n/u).map(line => {
    const heading = line.match(/^(#{1,3}\s+)(.+)$/u);
    if (!heading || /<span\b[^>]*\bstyle\s*=|<h[1-3]\b/iu.test(heading[2])) return line;
    return `${heading[1]}<span style="color:${safeColor}">${heading[2]}</span>`;
  }).join('\n');
}

export function normalizeWechatHeadings(body: string): string {
  return body.split(/\r?\n/u).map(line => {
    const value = line.trim();
    if (!value || value.length > 80 || /^#{1,6}\s|^[-*+]\s|^\d+[.)、]\s|^>|^!\[|^\|/u.test(value)) return line;
    if (/^[一二三四五六七八九十]{1,3}、\S/u.test(value)) return `## ${value}`;
    if (/^第\s*\d+\s*条\s*[｜|:：]\s*\S/u.test(value) || /^第[一二三四五六七八九十]+类\s*[｜|:：]\s*\S/u.test(value)) return `### ${value}`;
    return line;
  }).join('\n');
}

/** Word/Google Docs paragraph styles take precedence over textual inference. */
export function docxHeading(text: string, paragraphXml: string): string {
  if (/^\s*【[^】]+】\s*$/u.test(text) || /^\s*(?:VBE-\d{8}-\d{3}|(?:content_id|title|status)\s*:)/iu.test(text)) return text;
  const style = paragraphXml.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/u)?.[1] ?? '';
  if (/^(?:Heading|heading|标题)[123]$/u.test(style)) {
    const level = /3$/u.test(style) ? 3 : 2;
    const color = paragraphXml.match(/<w:color\b[^>]*\bw:val="([0-9A-Fa-f]{6})"/u)?.[1];
    if (color) return `<h${level} style="color:#${color.toUpperCase()}">${text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')}</h${level}>`;
    return `${'#'.repeat(level)} ${text.replace(/^#{1,6}\s+/u, '')}`;
  }
  return text;
}
