import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';
export const scanRepository = {
  async create(input) { return unwrap(await getSupabaseAdmin().from('scan_runs').insert(input).select().single(), 'create scan run'); },
  async update(id, patch) { return unwrap(await getSupabaseAdmin().from('scan_runs').update(patch).eq('id', id).select().single(), 'update scan run'); },
  async listBySite(siteId) { return unwrap(await getSupabaseAdmin().from('scan_runs').select('*').eq('site_id', siteId).order('created_at', { ascending: false }), 'list scan runs'); },
};
