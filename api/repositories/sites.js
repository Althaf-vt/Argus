import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';
export const siteRepository = {
  async getById(id) { return unwrap(await getSupabaseAdmin().from('monitored_sites').select('*').eq('id', id).maybeSingle(), 'get monitored site'); },
  async listByWorkspace(workspaceId) { return unwrap(await getSupabaseAdmin().from('monitored_sites').select('*').eq('workspace_id', workspaceId).is('archived_at', null).order('created_at', { ascending: false }), 'list monitored sites'); },
  async create(input) { return unwrap(await getSupabaseAdmin().from('monitored_sites').insert(input).select().single(), 'create monitored site'); },
  async getByWorkspaceRootAndMode(workspaceId, normalizedRootUrl) { return unwrap(await getSupabaseAdmin().from('monitored_sites').select('*').eq('workspace_id', workspaceId).eq('normalized_root_url', normalizedRootUrl).eq('mode', 'SPECIFIC_PAGE').is('archived_at', null).maybeSingle(), 'get monitored site'); },
  async update(id, patch) { return unwrap(await getSupabaseAdmin().from('monitored_sites').update(patch).eq('id', id).select().single(), 'update monitored site'); },
  async archive(id) { return unwrap(await getSupabaseAdmin().from('monitored_sites').update({ state: 'ARCHIVED', archived_at: new Date().toISOString() }).eq('id', id).select().single(), 'archive monitored site'); },
};
