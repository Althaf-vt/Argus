import crypto from 'node:crypto';
import { fetchPublicHtml, validatePublicUrl } from '../lib/safe-fetch.js';
import { analyzeChange } from '../lib/analyst.js';
import { extractReadableText } from '../../lib/monitoring/extractor.js';
import { computeDiff } from '../../lib/monitoring/differ.js';
import { workspaceRepository } from '../repositories/workspaces.js';
import { siteRepository } from '../repositories/sites.js';
import { pageRepository } from '../repositories/pages.js';
import { scanRepository } from '../repositories/scans.js';
import { snapshotRepository } from '../repositories/snapshots.js';
import { eventRepository } from '../repositories/events.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalize = async (url) => { const target = await validatePublicUrl(url); target.hash = ''; return target.toString(); };
const safeLabel = (value) => typeof value === 'string' ? value.trim().slice(0, 240) : '';
const titleFromHtml = (html) => (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000);
const scheduleSeconds = { '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };
const intervalFor = (value) => scheduleSeconds[value] || null;

async function resolveTarget({ url, label, filterNoise, monitorInterval }) {
  const canonicalUrl = await canonicalize(url); const workspace = await workspaceRepository.getDefault();
  let site = await siteRepository.getByWorkspaceRootAndMode(workspace.id, canonicalUrl);
  if (!site) site = await siteRepository.create({ workspace_id: workspace.id, normalized_root_url: canonicalUrl, display_root_url: canonicalUrl, mode: 'SPECIFIC_PAGE', context_label: safeLabel(label), state: 'ACTIVE', interval_seconds: intervalFor(monitorInterval) || 3600, next_check_at: intervalFor(monitorInterval) ? new Date(Date.now() + intervalFor(monitorInterval) * 1000).toISOString() : null, rules: { filterNoise: filterNoise !== false }, discovery_enabled: false });
  else if (safeLabel(label) && site.context_label !== safeLabel(label)) site = await siteRepository.update(site.id, { context_label: safeLabel(label), rules: { ...site.rules, filterNoise: filterNoise !== false } });
  else if (site.rules?.filterNoise !== (filterNoise !== false)) site = await siteRepository.update(site.id, { rules: { ...site.rules, filterNoise: filterNoise !== false } });
  const canonicalUrlHash = hash(canonicalUrl); let page = await pageRepository.getBySiteAndHash(site.id, canonicalUrlHash);
  if (!page) page = await pageRepository.create({ site_id: site.id, canonical_url: canonicalUrl, canonical_url_hash: canonicalUrlHash, lifecycle: 'BASELINING', discovery_source: 'MANUAL' });
  return { workspace, site, page, canonicalUrl };
}

async function executeSpecificPageCheck(target, scan, filterNoise) {
  try {
    const fetched = await fetchPublicHtml(target.canonicalUrl); const text = extractReadableText(fetched.html, { filterNoise: filterNoise !== false }); if (!text) throw new Error('No readable page content was found');
    const current = await snapshotRepository.getCurrent(target.page.id); const observedAt = fetched.fetchedAt; const contentHash = hash(text); const title = titleFromHtml(fetched.html);
    if (!current) {
      const committed = await snapshotRepository.commitObservation({ p_page_id: target.page.id, p_scan_run_id: scan.id, p_expected_current_snapshot_id: null, p_content_hash: contentHash, p_normalized_text: text, p_title: title, p_observed_at: observedAt, p_is_changed_revision: false, p_event: null });
      await scanRepository.update(scan.id, { status: 'SUCCEEDED', completed_at: new Date().toISOString(), pages_succeeded: 1 });
      return { outcome: 'BASELINE', target: presentTarget(target, observedAt), scanId: scan.id, snapshot: committed.snapshot };
    }
    if (current.content_hash === contentHash) {
      await pageRepository.update(target.page.id, { lifecycle: 'ACTIVE', last_checked_at: observedAt, last_success_at: observedAt, last_http_status: fetched.httpStatus, consecutive_missing_count: 0 });
      await scanRepository.update(scan.id, { status: 'SUCCEEDED', completed_at: new Date().toISOString(), pages_succeeded: 1 });
      return { outcome: 'NO_CHANGE', target: presentTarget(target, observedAt), scanId: scan.id };
    }
    const diff = computeDiff(current.normalized_text, text); const analysis = await analyzeChange({ url: target.canonicalUrl, label: target.site.context_label, diffText: diff.diffText });
    const committed = await snapshotRepository.commitObservation({ p_page_id: target.page.id, p_scan_run_id: scan.id, p_expected_current_snapshot_id: current.id, p_content_hash: contentHash, p_normalized_text: text, p_title: title, p_observed_at: observedAt, p_is_changed_revision: true, p_event: { compact_diff: diff.diffText, deterministic_metrics: { added_characters: diff.addedCount, removed_characters: diff.removedCount }, evidence: { source: 'manual_specific_page' }, ...analysis } });
    await scanRepository.update(scan.id, { status: 'SUCCEEDED', completed_at: new Date().toISOString(), pages_succeeded: 1, pages_changed: 1, gemini_calls: 1 });
    return { outcome: 'CHANGE_DETECTED', target: presentTarget(target, observedAt), scanId: scan.id, analysis, event: presentEvent(committed.event), diff: { displayDiffs: diff.displayDiffs, addedCount: diff.addedCount, removedCount: diff.removedCount, diffText: diff.diffText } };
  } catch (error) {
    await scanRepository.update(scan.id, { status: 'FAILED', completed_at: new Date().toISOString(), pages_failed: 1, error_code: error?.message === 'ARGUS_SNAPSHOT_CONFLICT' ? 'SNAPSHOT_CONFLICT' : 'CHECK_FAILED', redacted_error: 'Specific Page check failed; the previous successful snapshot was retained.' }).catch(() => {});
    throw error;
  }
}

export async function runSpecificPageCheck(input) {
  const target = await resolveTarget(input); const scan = await scanRepository.create({ site_id: target.site.id, trigger: 'MANUAL', status: 'RUNNING', idempotency_key: crypto.randomUUID(), started_at: new Date().toISOString(), pages_attempted: 1 });
  return executeSpecificPageCheck(target, scan, input.filterNoise);
}

export async function runClaimedSpecificPageCheck(claim) {
  const target = { site: { id: claim.site_id, context_label: claim.context_label, rules: claim.rules || {} }, page: { id: claim.page_id }, canonicalUrl: claim.canonical_url };
  const scan = { id: claim.scan_run_id };
  return executeSpecificPageCheck(target, scan, claim.rules?.filterNoise !== false);
}

export async function dispatchDueSpecificPageScans(limit = 5) {
  const claims = await siteRepository.claimDueSpecificPages(limit); const results = [];
  for (const claim of claims) {
    try {
      const result = await runClaimedSpecificPageCheck(claim);
      await siteRepository.completeScheduledScan(claim.site_id, claim.scan_run_id, claim.lease_token);
      results.push({ siteId: claim.site_id, outcome: result.outcome });
    } catch (error) {
      await siteRepository.failScheduledScan(claim.site_id, claim.scan_run_id, claim.lease_token, error?.message === 'ARGUS_SNAPSHOT_CONFLICT' ? 'SNAPSHOT_CONFLICT' : 'CHECK_FAILED').catch(() => {});
      results.push({ siteId: claim.site_id, outcome: 'FAILED' });
    }
  }
  return { claimed: claims.length, results };
}
const presentTarget = (target, checkedAt) => ({ id: target.page.id, siteId: target.site.id, url: target.canonicalUrl, label: target.site.context_label, filterNoise: target.site.rules?.filterNoise !== false, monitorInterval: target.site.next_check_at ? Object.entries(scheduleSeconds).find(([, seconds]) => seconds === target.site.interval_seconds)?.[0] || 'MANUAL' : 'MANUAL', nextCheckAt: target.site.next_check_at, status: 'NO_CHANGE', lastCheckedAt: checkedAt });
export const presentEvent = (event) => event && ({ id: event.id, detectedAt: event.occurred_at, summary: event.summary, severity: event.severity, areas_affected: event.areas_affected || [], recommended_action: event.recommended_action || '', reasoning: event.reasoning || '', diffSnippet: event.compact_diff || '', deterministicMetrics: event.deterministic_metrics || {} });

export async function listSpecificPageTargets() {
  const workspace = await workspaceRepository.getDefault(); const sites = await siteRepository.listByWorkspace(workspace.id); const specific = sites.filter((site) => site.mode === 'SPECIFIC_PAGE');
  const targets = await Promise.all(specific.map(async (site) => { const [page] = await pageRepository.listBySite(site.id); if (!page) return null; const events = (await eventRepository.listByPage(page.id)).map(presentEvent); const monitorInterval = Object.entries(scheduleSeconds).find(([, seconds]) => seconds === site.interval_seconds)?.[0] || 'MANUAL'; return { id: page.id, siteId: site.id, url: page.canonical_url, label: site.context_label, filterNoise: site.rules?.filterNoise !== false, monitorInterval: site.next_check_at ? monitorInterval : 'MANUAL', nextCheckAt: site.next_check_at, status: page.lifecycle === 'CHANGED' ? 'CHANGE_DETECTED' : 'NO_CHANGE', lastCheckedAt: page.last_checked_at, lastChangeAt: events[0]?.detectedAt || null, history: events }; }));
  return targets.filter(Boolean);
}
