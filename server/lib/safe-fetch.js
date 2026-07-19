import dns from 'node:dns/promises';
import net from 'node:net';

const ipv4Private = (ip) => { const p = ip.split('.').map(Number); if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true; const [a, b] = p; return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || a >= 224; };
const ipv6Private = (ip) => { const value = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]; if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return true; const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return Boolean(mapped && ipv4Private(mapped[1])); };
const unsafe = (address) => net.isIP(address) === 4 ? ipv4Private(address) : net.isIP(address) === 6 ? ipv6Private(address) : true;

export async function validatePublicUrl(value) {
  const target = value instanceof URL ? value : new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Only public HTTP(S) URLs without credentials are allowed');
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host === 'metadata' || host === '169.254.169.254') throw new Error('Private or metadata destinations are not allowed');
  if (net.isIP(host)) { if (unsafe(host)) throw new Error('Private or internal IP addresses are not allowed'); return target; }
  const resolved = await dns.lookup(host, { all: true, verbatim: true });
  if (!resolved.length || resolved.some(({ address }) => unsafe(address))) throw new Error('Destination resolves to a private or internal address');
  return target;
}

export async function fetchPublicResource(url, { redirectLimit = 6, timeoutMs = 10_000, maxBytes = 1024 * 1024, accepts = null, invalidContentMessage = 'Target did not return an accepted document' } = {}) {
  let target = await validatePublicUrl(url); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    for (let redirects = 0; redirects <= redirectLimit; redirects += 1) {
      response = await fetch(target, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'ARGUS-Monitor/2.0', Accept: accepts ? 'text/html,application/xhtml+xml,application/xml,text/xml,text/plain' : 'text/html,application/xhtml+xml' } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location'); if (!location) throw new Error('Target returned an invalid redirect');
      target = await validatePublicUrl(new URL(location, target)); if (redirects === redirectLimit) throw new Error('Too many redirects');
    }
    if (!response.ok) throw new Error(`Target URL returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || ''; const expected = accepts || /^(text\/html|application\/xhtml\+xml)/i;
    if (!expected.test(contentType)) throw new Error(invalidContentMessage);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Target returned an empty response body'); let bytes = 0; const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) { await reader.cancel(); throw new Error(maxBytes === 1024 * 1024 ? 'Target response exceeds the 1 MiB limit' : 'Target response exceeds the configured size limit'); } chunks.push(value); }
    const body = new Uint8Array(bytes); let offset = 0; chunks.forEach((chunk) => { body.set(chunk, offset); offset += chunk.byteLength; });
    return { body: new TextDecoder().decode(body), fetchedAt: new Date().toISOString(), finalUrl: target.toString(), httpStatus: response.status, contentType };
  } catch (error) { if (error?.name === 'AbortError') throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`, { cause: error }); throw error; } finally { clearTimeout(timeout); }
}

export async function fetchPublicHtml(url, options = {}) {
  const response = await fetchPublicResource(url, { ...options, accepts: /^(text\/html|application\/xhtml\+xml)/i, invalidContentMessage: 'Target did not return an HTML document' });
  return { html: response.body, fetchedAt: response.fetchedAt, finalUrl: response.finalUrl, httpStatus: response.httpStatus };
}
