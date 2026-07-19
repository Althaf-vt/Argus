import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';
export const workspaceRepository = {
  async getById(id) { return unwrap(await getSupabaseAdmin().from('workspaces').select('*').eq('id', id).maybeSingle(), 'get workspace'); },
  async listForOwner(ownerUserId) { return unwrap(await getSupabaseAdmin().from('workspaces').select('*').eq('owner_user_id', ownerUserId).is('archived_at', null).order('created_at', { ascending: false }), 'list workspaces'); },
  async create(input) { return unwrap(await getSupabaseAdmin().from('workspaces').insert(input).select().single(), 'create workspace'); },
};
