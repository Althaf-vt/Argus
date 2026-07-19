import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';
export const siteRepository = {
  async getById(id) { return unwrap(await getSupabaseAdmin().from('monitored_sites').select('*').eq('id', id).maybeSingle(), 'get monitored site'); },
  async listByWorkspace(workspaceId) { return unwrap(await getSupabaseAdmin().from('monitored_sites').select('*').eq('workspace_id', workspaceId).is('archived_at', null).order('created_at', { ascending: false }), 'list monitored sites'); },
  async create(input) { return unwrap(await getSupabaseAdmin().from('monitored_sites').insert(input).select().single(), 'create monitored site'); },
  async getByWorkspaceRootAndMode(workspaceId, normalizedRootUrl, mode = 'SPECIFIC_PAGE') { return unwrap(await getSupabaseAdmin().from('monitored_sites').select('*').eq('workspace_id', workspaceId).eq('normalized_root_url', normalizedRootUrl).eq('mode', mode).is('archived_at', null).maybeSingle(), 'get monitored site'); },
  async update(id, patch) { return unwrap(await getSupabaseAdmin().from('monitored_sites').update(patch).eq('id', id).select().single(), 'update monitored site'); },
  async archive(id) { return unwrap(await getSupabaseAdmin().from('monitored_sites').update({ state: 'ARCHIVED', archived_at: new Date().toISOString() }).eq('id', id).select().single(), 'archive monitored site'); },
  async configureSchedule(id, intervalSeconds) { return unwrap(await getSupabaseAdmin().rpc('argus_configure_specific_page_schedule', { p_site_id: id, p_interval_seconds: intervalSeconds }), 'configure monitored site schedule'); },
  async claimDueSpecificPages(limit = 5) { return unwrap(await getSupabaseAdmin().rpc('argus_claim_due_specific_page_scans', { p_limit: limit }), 'claim due specific page scans'); },
  async completeScheduledScan(siteId, scanRunId, leaseToken) { return unwrap(await getSupabaseAdmin().rpc('argus_complete_scheduled_scan', { p_site_id: siteId, p_scan_run_id: scanRunId, p_lease_token: leaseToken }), 'complete scheduled scan'); },
  async failScheduledScan(siteId, scanRunId, leaseToken, errorCode) { return unwrap(await getSupabaseAdmin().rpc('argus_fail_scheduled_scan', { p_site_id: siteId, p_scan_run_id: scanRunId, p_lease_token: leaseToken, p_error_code: errorCode }), 'fail scheduled scan'); },
};
