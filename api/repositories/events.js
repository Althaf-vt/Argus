import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';
export const eventRepository = {
  async create(input) { return unwrap(await getSupabaseAdmin().from('change_events').insert(input).select().single(), 'create change event'); },
  async listByPage(pageId) { return unwrap(await getSupabaseAdmin().from('change_events').select('*').eq('page_id', pageId).order('occurred_at', { ascending: false }), 'list change events'); },
  async markRead(id) { return unwrap(await getSupabaseAdmin().from('change_events').update({ read_at: new Date().toISOString() }).eq('id', id).select().single(), 'mark change event read'); },
};
