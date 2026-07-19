import dns from 'node:dns/promises';
import net from 'node:net';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const rateWindowMs = 10 * 60 * 1000;
const rateLimit = 20;
const requests = new Map();

const ipv4Private = (ip) => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || a >= 224;
};

const ipv6Private = (ip) => {
  const value = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return Boolean(mapped && ipv4Private(mapped[1]));
};

const isUnsafeAddress = (address) => net.isIP(address) === 4 ? ipv4Private(address) : net.isIP(address) === 6 ? ipv6Private(address) : true;

async function validateTarget(value) {
  const target = value instanceof URL ? value : new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Only public HTTP(S) URLs without credentials are allowed');
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host === 'metadata' || host === '169.254.169.254') throw new Error('Private or metadata destinations are not allowed');
  if (net.isIP(host)) {
    if (isUnsafeAddress(host)) throw new Error('Private or internal IP addresses are not allowed');
    return target;
  }
  const resolved = await dns.lookup(host, { all: true, verbatim: true });
  if (!resolved.length || resolved.some(({ address }) => isUnsafeAddress(address))) throw new Error('Destination resolves to a private or internal address');
  return target;
}

function clientKey(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || 'anonymous').split(',')[0].trim();
}

function isRateLimited(key) {
  const now = Date.now();
  const existing = (requests.get(key) || []).filter((time) => now - time < rateWindowMs);
  if (existing.length >= rateLimit) { requests.set(key, existing); return true; }
  existing.push(now); requests.set(key, existing);
  if (requests.size > 5000) for (const [entry, times] of requests) if (!times.length || now - times.at(-1) >= rateWindowMs) requests.delete(entry);
  return false;
}

export default async function handler(req, res) {
  Object.entries(cors).forEach(([key, value]) => res.setHeader(key, value));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (isRateLimited(clientKey(req))) return res.status(429).json({ error: 'Too many checks. Please try again later.' });

  let target;
  try { target = await validateTarget(req.body?.url); } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'A valid public URL is required' }); }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let response;
    for (let redirects = 0; redirects < 6; redirects += 1) {
      response = await fetch(target, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'ARGUS-Monitor/1.0', Accept: 'text/html,application/xhtml+xml' } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) return res.status(502).json({ error: 'Target returned an invalid redirect' });
      target = await validateTarget(new URL(location, target));
      if (redirects === 5) return res.status(502).json({ error: 'Too many redirects' });
    }
    if (!response.ok) return res.status(502).json({ error: `Target URL returned HTTP ${response.status}` });
    return res.status(200).json({ html: await response.text(), fetchedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(error?.name === 'AbortError' ? 504 : 502).json({ error: error?.name === 'AbortError' ? 'Request timed out after 10 seconds' : error instanceof Error ? `Failed to fetch URL: ${error.message}` : 'Failed to fetch URL' });
  } finally { clearTimeout(timeout); }
}
