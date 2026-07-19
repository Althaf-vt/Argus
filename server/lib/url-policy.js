const trackingKey = /^(utm_.+|gclid|fbclid|mc_.+)$/i;
const excludedPath = /(?:^|\/)(?:logout|log-out|login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|account|admin|password-reset|reset-password|session)(?:\/|$)/i;
const trapKey = /(?:^|_)(?:search|q|query|filter|sort|facet|calendar|date|page|offset|cursor|session|token|sid)(?:_|$)/i;
const assetPath = /\.(?:pdf|zip|gz|rar|7z|png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|css|js|mjs|json|xml|txt|csv|docx?|xlsx?|pptx?)(?:$|\/)/i;

export function normalizeDiscoveryUrl(value, rootUrl) {
  const url = new URL(value, rootUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const root = new URL(rootUrl);
  if (url.origin !== root.origin) return null;
  url.hash = '';
  const retained = [];
  for (const [key, entry] of url.searchParams) {
    if (trackingKey.test(key)) continue;
    retained.push([key, entry]);
  }
  if (retained.length) return null; // Query URLs are opt-in only; Phase 4 has no allowlist.
  url.search = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

export function discoveryExclusion(urlValue) {
  const url = new URL(urlValue);
  if (assetPath.test(url.pathname)) return 'NON_HTML_RESOURCE';
  if (excludedPath.test(url.pathname)) return 'EXCLUDED_PATH';
  if ([...url.searchParams.keys()].some((key) => trapKey.test(key))) return 'QUERY_TRAP';
  return null;
}

export function extractHtmlLinks(html, baseUrl) {
  const links = []; const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  for (let match; (match = pattern.exec(html));) {
    const href = match[1] ?? match[2] ?? match[3];
    if (href && !/^(?:mailto:|tel:|javascript:|data:)/i.test(href)) links.push(href);
  }
  return links.map((href) => normalizeDiscoveryUrl(href, baseUrl)).filter(Boolean);
}

export function extractCanonicalUrl(html, baseUrl) {
  const match = html.match(/<link\b[^>]*\brel\s*=\s*(?:"canonical"|'canonical'|canonical)[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    || html.match(/<link\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*\brel\s*=\s*(?:"canonical"|'canonical'|canonical)/i);
  return match ? normalizeDiscoveryUrl(match[1] ?? match[2] ?? match[3], baseUrl) : null;
}
