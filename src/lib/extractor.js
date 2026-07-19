function filterDynamicNoise(text) {
  return text
    .replace(/\b(?:just now|moments? ago|today|yesterday)\b/gi, '[dynamic time]')
    .replace(/\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/gi, '[dynamic time]')
    .replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '[timestamp]')
    .replace(/\b(?:\d{1,2}[/-]){2}\d{2,4}\b/g, '[date]')
    .replace(/\b[\d,.]+\s*(?:views?|visitors?|people viewing|watching now)\b/gi, '[dynamic counter]');
}

export function extractReadableText(html = '', { filterNoise = false } = {}) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,nav,footer,head,noscript,template').forEach((node) => node.remove());
    const text = (doc.body?.innerText || '').replace(/\n[\t ]*\n+/g, '\n\n').replace(/[\t ]+/g, ' ').trim();
    return filterNoise ? filterDynamicNoise(text) : text;
  } catch {
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return filterNoise ? filterDynamicNoise(text) : text;
  }
}
