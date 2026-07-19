import crypto from 'node:crypto';
import { fetchPublicHtml, fetchPublicResource, validatePublicUrl } from '../lib/safe-fetch.js';
import { extractReadableText } from '../../lib/monitoring/extractor.js';
import { workspaceRepository } from '../repositories/workspaces.js';
import { siteRepository } from '../repositories/sites.js';
import { pageRepository } from '../repositories/pages.js';
import { scanRepository } from '../repositories/scans.js';
import { snapshotRepository } from '../repositories/snapshots.js';
import { discoveryExclusion, extractCanonicalUrl, extractHtmlLinks, normalizeDiscoveryUrl } from '../lib/url-policy.js';

const limits = { pages: 100, depth: 4, timeoutMs: 10_000, responseBytes: 1024 * 1024, redirectLimit: 3, sitemapDepth: 5, runMs: 5 * 60_000, aggregateBytes: 25 * 1024 * 1024, requestSpacingMs: 1_000 };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const titleFromHtml = (html) => (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000);
const xmlLocs = (xml) => [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map((match) => match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()).filter(Boolean);
const isIndex = (xml) => /<sitemapindex\b/i.test(xml);

class Budget {
  constructor() { this.started = Date.now(); this.bytes = 0; this.lastRequestAt = 0; this.capped = false; }
  ensure() { if (Date.now() - this.started > limits.runMs) { this.capped = true; throw new Error('DISCOVERY_TIME_BUDGET'); } if (this.bytes >= limits.aggregateBytes) { this.capped = true; throw new Error('DISCOVERY_BYTE_BUDGET'); } }
  async wait() { this.ensure(); const remaining = limits.requestSpacingMs - (Date.now() - this.lastRequestAt); if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining)); this.lastRequestAt = Date.now(); }
  add(text) { this.bytes += new TextEncoder().encode(text || '').byteLength; this.ensure(); }
}

async function resource(url, budget, accepts) { await budget.wait(); const maxBytes = Math.min(limits.responseBytes, limits.aggregateBytes - budget.bytes); const response = await fetchPublicResource(url, { redirectLimit: limits.redirectLimit, timeoutMs: limits.timeoutMs, maxBytes, accepts }); budget.add(response.body); return response; }
function robotsPolicy(text, rootUrl) {
  const lines = text.split(/\r?\n/); const sitemaps = []; let applies = false; const disallow = [];
  for (const raw of lines) { const line = raw.replace(/#.*/, '').trim(); const separator = line.indexOf(':'); if (separator < 0) continue; const key = line.slice(0, separator).trim().toLowerCase(); const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') applies = value === '*' || value.toLowerCase() === 'argus-monitor';
    else if (key === 'disallow' && applies && value) disallow.push(value);
    else if (key === 'sitemap') { try { sitemaps.push(new URL(value, rootUrl).toString()); } catch { continue; } }
  }
  return { sitemaps, allowed: (url) => !disallow.some((path) => new URL(url).pathname.startsWith(path)) };
}

async function discover(rootUrl, budget) {
  let robots = { sitemaps: [], allowed: () => true };
  try { const response = await resource(new URL('/robots.txt', rootUrl).toString(), budget, /^(text\/plain|text\/html)/i); robots = robotsPolicy(response.body, rootUrl); } catch { robots = { ...robots }; }
  const sitemapQueue = [...new Set([...robots.sitemaps, new URL('/sitemap.xml', rootUrl).toString()])].map((url) => ({ url, depth: 0 }));
  const seenSitemaps = new Set(); const candidates = new Map(); const ignored = new Map(); const add = (value, source, evidence = {}) => { const normalized = normalizeDiscoveryUrl(value, rootUrl); if (!normalized) return; const exclusion = discoveryExclusion(normalized); if (exclusion || !robots.allowed(normalized)) { ignored.set(normalized, exclusion || 'ROBOTS_DISALLOWED'); return; } if (!candidates.has(normalized) && candidates.size < limits.pages) candidates.set(normalized, { url: normalized, source, evidence }); else if (!candidates.has(normalized)) budget.capped = true; };
  while (sitemapQueue.length) { const item = sitemapQueue.shift(); if (item.depth > limits.sitemapDepth || seenSitemaps.has(item.url)) continue; seenSitemaps.add(item.url); try { const response = await resource(item.url, budget, /^(application\/xml|text\/xml|text\/plain)/i); for (const loc of xmlLocs(response.body)) { if (isIndex(response.body)) sitemapQueue.push({ url: loc, depth: item.depth + 1 }); else add(loc, 'SITEMAP', { sitemap: item.url }); } } catch { /* Broken sitemap is a non-fatal discovery source. */ } }
  const queue = [{ url: rootUrl, depth: 0 }]; const crawled = new Set();
  while (queue.length && candidates.size < limits.pages) { budget.ensure(); const item = queue.shift(); if (crawled.has(item.url) || !robots.allowed(item.url)) continue; crawled.add(item.url); add(item.url, item.depth === 0 ? 'ROOT' : 'LINK', { depth: item.depth });
    try { const response = await resource(item.url, budget, /^(text\/html|application\/xhtml\+xml)/i); const canonical = extractCanonicalUrl(response.body, item.url); if (canonical) add(canonical, 'CANONICAL', { discoveredFrom: item.url }); if (item.depth < limits.depth) for (const link of extractHtmlLinks(response.body, item.url)) if (!crawled.has(link) && !discoveryExclusion(link) && robots.allowed(link)) queue.push({ url: link, depth: item.depth + 1 }); } catch { /* Individual crawl failures are reported during baseline if selected. */ }
  }
  const selected = [...candidates.values()].slice(0, limits.pages); return { selected, ignored: [...ignored.entries()].map(([url, reason]) => ({ url, reason })), found: candidates.size, capped: candidates.size >= limits.pages || budget.capped, robotsSitemaps: robots.sitemaps.length };
}

export async function createEntireWebsiteTarget({ url, label = '', filterNoise = true }) {
  const validated = await validatePublicUrl(url); validated.hash = ''; validated.search = ''; if (validated.pathname.length > 1 && validated.pathname.endsWith('/')) validated.pathname = validated.pathname.slice(0, -1); const rootUrl = validated.toString();
  const workspace = await workspaceRepository.getDefault(); let site = await siteRepository.getByWorkspaceRootAndMode(workspace.id, rootUrl, 'ENTIRE_WEBSITE');
  if (site) return presentSite(site, await pageRepository.listBySite(site.id), null, true);
  site = await siteRepository.create({ workspace_id: workspace.id, normalized_root_url: rootUrl, display_root_url: rootUrl, mode: 'ENTIRE_WEBSITE', context_label: label.trim().slice(0, 240), state: 'DISCOVERING', rules: { filterNoise: filterNoise !== false }, discovery_enabled: true });
  const scan = await scanRepository.create({ site_id: site.id, trigger: 'INITIAL', status: 'RUNNING', idempotency_key: `initial:${site.id}` , started_at: new Date().toISOString() }); const budget = new Budget();
  try { const outcome = await discover(rootUrl, budget); let succeeded = 0; let failed = 0;
    for (const candidate of outcome.selected) { let page = await pageRepository.getBySiteAndHash(site.id, hash(candidate.url)); if (!page) page = await pageRepository.create({ site_id: site.id, canonical_url: candidate.url, canonical_url_hash: hash(candidate.url), lifecycle: 'DISCOVERED', discovery_source: candidate.source, discovery_evidence: candidate.evidence }); await pageRepository.update(page.id, { lifecycle: 'BASELINING' });
      try { await budget.wait(); const fetched = await fetchPublicHtml(candidate.url, { redirectLimit: limits.redirectLimit, timeoutMs: limits.timeoutMs, maxBytes: Math.min(limits.responseBytes, limits.aggregateBytes - budget.bytes) }); budget.add(fetched.html); const text = extractReadableText(fetched.html, { filterNoise: filterNoise !== false }); if (!text) throw new Error('No readable page content was found'); await snapshotRepository.commitObservation({ p_page_id: page.id, p_scan_run_id: scan.id, p_expected_current_snapshot_id: null, p_content_hash: hash(text), p_normalized_text: text, p_title: titleFromHtml(fetched.html), p_observed_at: fetched.fetchedAt, p_is_changed_revision: false, p_event: null }); succeeded += 1;
      } catch (error) { failed += 1; await pageRepository.update(page.id, { lifecycle: 'UNREACHABLE', health: { code: error.message === 'DISCOVERY_TIME_BUDGET' ? 'TIME_BUDGET' : 'BASELINE_FAILED', message: 'Initial baseline failed; no successful baseline was replaced.' }, last_checked_at: new Date().toISOString() }); }
    }
    const summary = { found: outcome.found, eligible: outcome.selected.length, active: succeeded, ignored: outcome.ignored.length, failed, capped: outcome.capped, aggregate_bytes: budget.bytes, robots_sitemaps: outcome.robotsSitemaps };
    const status = succeeded === 0 ? 'FAILED' : failed || outcome.capped ? 'PARTIAL' : 'SUCCEEDED'; site = await siteRepository.update(site.id, { state: succeeded ? 'ACTIVE' : 'ERRORED', last_scan_at: new Date().toISOString(), last_error_code: succeeded ? null : 'INITIAL_BASELINE_FAILED', last_error_message: succeeded ? null : 'No page could be baselined during initial discovery.' }); await scanRepository.update(scan.id, { status, completed_at: new Date().toISOString(), pages_attempted: outcome.selected.length, pages_succeeded: succeeded, pages_failed: failed, discovery_summary: summary }); return presentSite(site, await pageRepository.listBySite(site.id), summary, false);
  } catch (error) { const summary = { failed: true, capped: budget.capped, aggregate_bytes: budget.bytes }; await scanRepository.update(scan.id, { status: 'FAILED', completed_at: new Date().toISOString(), redacted_error: 'Entire Website discovery failed before a usable baseline was established.', discovery_summary: summary }).catch(() => {}); await siteRepository.update(site.id, { state: 'ERRORED', last_error_code: 'INITIAL_DISCOVERY_FAILED', last_error_message: 'Initial website discovery failed.' }).catch(() => {}); throw error; }
}

export const presentSite = (site, pages, summary = null, existing = false) => ({ id: site.id, siteId: site.id, url: site.display_root_url, label: site.context_label, mode: 'ENTIRE_WEBSITE', status: site.state, discoverySummary: summary, existing, inventory: pages.map((page) => ({ id: page.id, url: page.canonical_url, lifecycle: page.lifecycle, source: page.discovery_source, health: page.health })) });
export async function listEntireWebsiteTargets() { const workspace = await workspaceRepository.getDefault(); const sites = (await siteRepository.listByWorkspace(workspace.id)).filter((site) => site.mode === 'ENTIRE_WEBSITE'); return Promise.all(sites.map(async (site) => { const [run] = await scanRepository.listBySite(site.id); return presentSite(site, await pageRepository.listBySite(site.id), run?.discovery_summary || null); })); }
