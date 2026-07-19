function filterDynamicNoise(text) {
  return text.replace(/\b(?:just now|moments? ago|today|yesterday)\b/gi, '[dynamic time]').replace(/\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/gi, '[dynamic time]').replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '[timestamp]').replace(/\b(?:\d{1,2}[/-]){2}\d{2,4}\b/g, '[date]').replace(/\b[\d,.]+\s*(?:views?|visitors?|people viewing|watching now)\b/gi, '[dynamic counter]');
}
const decodeEntities = (text) => text.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (entity) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity.toLowerCase()] || ' ');
// Dependency-free on purpose: browser and server derive identical monitor text.
export function extractReadableText(html = '', { filterNoise = false } = {}) {
  const text = String(html).replace(/<(script|style|nav|footer|head|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|section|article|main|header)>/gi, '\n').replace(/<[^>]*>/g, ' ');
  const normalized = decodeEntities(text).replace(/\n[\t ]*\n+/g, '\n\n').replace(/[\t ]+/g, ' ').trim();
  return filterNoise ? filterDynamicNoise(normalized) : normalized;
}
