import { getSupabaseAdmin, unwrap } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const data = unwrap(await getSupabaseAdmin().rpc('argus_database_health'), 'database health check');
    return res.status(200).json(data?.ok ? { ok: true, database: 'connected' } : { ok: false, database: 'unavailable' });
  } catch {
    return res.status(503).json({ ok: false, database: 'unavailable' });
  }
}
