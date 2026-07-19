import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';
export const pageRepository = {
  async listBySite(siteId) { return unwrap(await getSupabaseAdmin().from('monitored_pages').select('*').eq('site_id', siteId).is('archived_at', null).order('canonical_url'), 'list monitored pages'); },
  async create(input) { return unwrap(await getSupabaseAdmin().from('monitored_pages').insert(input).select().single(), 'create monitored page'); },
  async update(id, patch) { return unwrap(await getSupabaseAdmin().from('monitored_pages').update(patch).eq('id', id).select().single(), 'update monitored page'); },
};
