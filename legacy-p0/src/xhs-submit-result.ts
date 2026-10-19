// Review acceptance completes delivery, not platform moderation. Error or
// ambiguous responses never authorize a second publish call.
export function classifyXhsSubmit(text: string, raw: unknown): 'PUBLISHED' | 'PUBLISHED_ID_PENDING' {
  const error = raw && typeof raw === 'object' && (raw as Record<string, unknown>).isError === true;
  if (error || /发布失败|提交失败|未提交|未发布|not\s+success|failed/i.test(text)) throw new Error(`Xiaohongshu ambiguous response: ${text}`);
  const reviewAccepted = /(?:已提交|提交成功)[^\n]{0,40}(?:审核|review)|(?:等待平台审核|待审核|审核中)/i.test(text);
  if (reviewAccepted) return 'PUBLISHED_ID_PENDING';
  if (!/发布完成|发布成功|success/i.test(text)) throw new Error(`Xiaohongshu ambiguous response: ${text}`);
  return /(?:PostID|note[_ ]?id|笔记ID)\s*[:：]?\s*[a-zA-Z0-9]+/i.test(text) ? 'PUBLISHED' : 'PUBLISHED_ID_PENDING';
}
