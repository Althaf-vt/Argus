import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';
export const snapshotRepository = {
  async getCurrent(pageId) { return unwrap(await getSupabaseAdmin().from('page_snapshots').select('*').eq('page_id', pageId).eq('is_current', true).maybeSingle(), 'get current snapshot'); },
  async create(input) { return unwrap(await getSupabaseAdmin().from('page_snapshots').insert(input).select().single(), 'create page snapshot'); },
  async markCurrent(id, pageId) { const db = getSupabaseAdmin(); unwrap(await db.from('page_snapshots').update({ is_current: false }).eq('page_id', pageId).eq('is_current', true), 'clear current snapshot'); return unwrap(await db.from('page_snapshots').update({ is_current: true }).eq('id', id).select().single(), 'mark current snapshot'); },
};
