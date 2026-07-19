import crypto from 'node:crypto';
import { fetchPublicHtml } from '../lib/safe-fetch.js';
import { extractReadableText } from '../../lib/monitoring/extractor.js';
import { DiscoveryBudget, discoveryLimits, discoverWebsite } from './entire-website-discovery.js';
import { siteRepository } from '../repositories/sites.js';
import { pageRepository } from '../repositories/pages.js';
import { scanRepository } from '../repositories/scans.js';
import { snapshotRepository } from '../repositories/snapshots.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const title = (html) => (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lifecycleEvent = async (page, scanId, lifecycle, missing, eventType = null, before = null, after = null, evidence = {}, redirect = undefined, health = {}) => pageRepository.recordLifecycle({
  p_page_id: page.id,
  p_scan_run_id: scanId,
  p_lifecycle: lifecycle,
  p_missing_count: missing,
  p_redirect_target_url: redirect === undefined ? page.redirect_target_url : redirect,
  p_health: health,
  p_event_type: eventType,
  p_before_snapshot_id: before,
  p_after_snapshot_id: after,
  p_evidence: evidence,
});

async function baseline(page, scanId, url, filterNoise, budget) {
  await budget.wait();
  const fetched = await fetchPublicHtml(url, {
    redirectLimit: discoveryLimits.redirectLimit,
    timeoutMs: discoveryLimits.timeoutMs,
    maxBytes: Math.min(discoveryLimits.responseBytes, discoveryLimits.aggregateBytes - budget.bytes),
  });
  budget.add(fetched.html);
  const text = extractReadableText(fetched.html, { filterNoise });
  if (!text) throw new Error('No readable page content was found');
  const current = await snapshotRepository.getCurrent(page.id);
  const committed = await snapshotRepository.commitObservation({
    p_page_id: page.id,
    p_scan_run_id: scanId,
    p_expected_current_snapshot_id: current?.id || null,
    p_content_hash: hash(text),
    p_normalized_text: text,
    p_title: title(fetched.html),
    p_observed_at: fetched.fetchedAt,
    p_is_changed_revision: false,
    p_event: null,
  });
  return { fetched, beforeSnapshotId: current?.id || null, afterSnapshotId: committed.snapshot.id };
}

async function observeRedirect(page, rootUrl, budget, filterNoise) {
  try {
    await budget.wait();
    const fetched = await fetchPublicHtml(page.canonical_url, {
      redirectLimit: discoveryLimits.redirectLimit,
      timeoutMs: discoveryLimits.timeoutMs,
      maxBytes: Math.min(discoveryLimits.responseBytes, discoveryLimits.aggregateBytes - budget.bytes),
    });
    budget.add(fetched.html);
    if (!fetched.redirectHops.length) return { kind: 'OK' };
    const finalUrl = new URL(fetched.finalUrl);
    if (finalUrl.origin !== new URL(rootUrl).origin) {
      return { kind: 'UNSAFE_REDIRECT', health: { code: 'OUT_OF_SCOPE_REDIRECT', redirect_hops: fetched.redirectHops, final_url: fetched.finalUrl } };
    }
    const text = extractReadableText(fetched.html, { filterNoise });
    if (!text) {
      return { kind: 'FAILED', health: { code: 'INVALID_REDIRECT_TARGET', message: 'Redirect target did not return readable HTML.', redirect_hops: fetched.redirectHops, final_url: fetched.finalUrl } };
    }
    const permanent = fetched.redirectHops.every((hop) => hop.status === 301 || hop.status === 308);
    const previous = page.health?.temporary_redirect;
    const sameTemporary = previous?.target_url === fetched.finalUrl && JSON.stringify(previous?.hops) === JSON.stringify(fetched.redirectHops);
    const temporaryCount = sameTemporary ? (previous.count || 0) + 1 : 1;
    if (!permanent && temporaryCount < 2) {
      return { kind: 'TEMPORARY', health: { temporary_redirect: { target_url: fetched.finalUrl, hops: fetched.redirectHops, count: temporaryCount } } };
    }
    return {
      kind: 'REDIRECTED',
      target: fetched.finalUrl,
      evidence: {
        source_url: page.canonical_url,
        redirect_hops: fetched.redirectHops,
        final_url: fetched.finalUrl,
        observed_at: fetched.fetchedAt,
        permanent,
      },
    };
  } catch (error) {
    const status = Number((error.message || '').match(/HTTP (\d{3})/)?.[1]);
    return {
      kind: status === 404 || status === 410 ? 'NOT_FOUND' : 'FAILED',
      health: { code: status ? `HTTP_${status}` : 'PROBE_FAILED', message: 'Lifecycle probe failed; previous baseline was retained.' },
    };
  }
}

export async function runClaimedEntireWebsiteRediscovery(claim) {
  const budget = new DiscoveryBudget();
  const site = await siteRepository.getById(claim.site_id);
  const pages = await pageRepository.listBySite(site.id);
  const existing = new Map(pages.map((page) => [page.canonical_url_hash, page]));
  const filterNoise = site.rules?.filterNoise !== false;
  const outcome = await discoverWebsite(site.normalized_root_url, budget);
  let succeeded = 0;
  let failed = 0;
  let added = 0;
  let removed = 0;
  const seen = new Set();
  const qualifying = outcome.qualifying;

  for (const candidate of outcome.selected) {
    const key = hash(candidate.url); seen.add(key); let page = existing.get(key);
    if (!page) { page = await pageRepository.create({ site_id: site.id, canonical_url: candidate.url, canonical_url_hash: key, lifecycle: 'DISCOVERED', discovery_source: candidate.source, discovery_evidence: { ...candidate.evidence, last_seen_at: new Date().toISOString() } }); try { await pageRepository.update(page.id, { lifecycle: 'BASELINING' }); const observed = await baseline(page, claim.scan_run_id, candidate.url, site.rules?.filterNoise !== false); await lifecycleEvent(page, claim.scan_run_id, 'ACTIVE', 0, 'NEW_PAGE', null, observed.afterSnapshotId, { source: candidate.source, url: candidate.url }); added += 1; succeeded += 1; } catch (error) { qualifying = false; failed += 1; await lifecycleEvent(page, claim.scan_run_id, 'UNREACHABLE', 0, null, null, null, {}, null, { code: 'NEW_BASELINE_FAILED', message: 'Discovered URL was not promoted to NEW_PAGE because baseline failed.' }); } continue; }
    if (['REMOVED', 'MISSING_CANDIDATE', 'UNREACHABLE'].includes(page.lifecycle)) { try { const observed = await baseline(page, claim.scan_run_id, candidate.url, site.rules?.filterNoise !== false); await lifecycleEvent(page, claim.scan_run_id, 'ACTIVE', 0, 'REAPPEARED', observed.beforeSnapshotId, observed.afterSnapshotId, { source: candidate.source, url: candidate.url }); succeeded += 1; } catch { qualifying = false; failed += 1; } continue; }
    await lifecycleEvent(page, claim.scan_run_id, 'ACTIVE', 0, null, null, null, { last_seen_at: new Date().toISOString(), source: candidate.source }, null, { last_seen_at: new Date().toISOString() }); succeeded += 1;
  }
  for (const page of pages.filter((entry) => !seen.has(entry.canonical_url_hash) && ['ACTIVE', 'MISSING_CANDIDATE'].includes(entry.lifecycle))) {
    const probe = await observeRedirect(page, site.normalized_root_url, claim.scan_run_id, budget);
    if (probe.kind === 'REDIRECTED') { const current = await snapshotRepository.getCurrent(page.id); await lifecycleEvent(page, claim.scan_run_id, 'REDIRECTED', 0, 'REDIRECTED', current?.id || null, null, probe.evidence, probe.target, { redirect: probe.evidence }); continue; }
    if (probe.kind === 'TEMPORARY' || probe.kind === 'UNSAFE_REDIRECT') { qualifying = false; await lifecycleEvent(page, claim.scan_run_id, page.lifecycle, page.consecutive_missing_count, null, null, null, {}, null, probe.health); continue; }
    if (!qualifying || probe.kind === 'FAILED') { qualifying = false; continue; }
    const missing = page.consecutive_missing_count + 1; const current = await snapshotRepository.getCurrent(page.id); const confirmed404 = probe.kind === 'NOT_FOUND'; if (missing >= 2 || (confirmed404 && missing >= 2)) { await lifecycleEvent(page, claim.scan_run_id, 'REMOVED', missing, 'REMOVED_PAGE', current?.id || null, null, { missing_cycles: missing, probe: probe.kind }); removed += 1; } else await lifecycleEvent(page, claim.scan_run_id, 'MISSING_CANDIDATE', missing, null, null, null, { missing_cycles: missing, probe: probe.kind }, null, { code: 'MISSING_CANDIDATE', missing_cycles: missing, probe: probe.kind });
  }

  const summary = {
    found: outcome.found,
    eligible: outcome.selected.length,
    active: succeeded,
    new: added,
    removed,
    failed,
    capped: outcome.capped,
    qualifying,
    root_fetched: outcome.rootFetched,
    reason: qualifying ? 'QUALIFYING' : 'INCOMPLETE_OR_PARTIAL',
  };
  const status = failed || !qualifying ? 'PARTIAL' : 'SUCCEEDED';
  await scanRepository.update(claim.scan_run_id, {
    status,
    completed_at: new Date().toISOString(),
    pages_attempted: outcome.selected.length,
    pages_succeeded: succeeded,
    pages_new: added,
    pages_removed: removed,
    pages_failed: failed,
    discovery_summary: summary,
  });
  return { status, summary };
}

export async function dispatchDueEntireWebsiteRediscoveries(limit = 2) {
  const claims = await siteRepository.claimDueEntireWebsiteRediscoveries(limit);
  const results = [];
  for (const claim of claims) {
    try {
      const result = await runClaimedEntireWebsiteRediscovery(claim);
      await siteRepository.completeEntireWebsiteRediscovery(claim.site_id, claim.scan_run_id, claim.lease_token);
      results.push({ siteId: claim.site_id, status: result.status });
    } catch {
      await scanRepository.update(claim.scan_run_id, {
        status: 'FAILED',
        completed_at: new Date().toISOString(),
        error_code: 'REDISCOVERY_FAILED',
        redacted_error: 'Entire Website rediscovery failed before results could be persisted.',
      }).catch(() => {});
      await siteRepository.failEntireWebsiteRediscovery(claim.site_id, claim.scan_run_id, claim.lease_token, 'REDISCOVERY_FAILED').catch(() => {});
      results.push({ siteId: claim.site_id, status: 'FAILED' });
    }
    await pause(0);
  }
  return { claimed: claims.length, results };
}
