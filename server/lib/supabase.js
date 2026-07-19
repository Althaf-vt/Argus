import { createClient } from '@supabase/supabase-js';

let client;
export function getSupabaseAdmin() {
  if (client) return client;
  const url = globalThis.process?.env?.SUPABASE_URL;
  const secret = globalThis.process?.env?.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error('Database service is not configured');
  client = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  return client;
}

export class DatabaseRepositoryError extends Error {
  constructor(operation, cause) { super(`Database operation failed: ${operation}`); this.name = 'DatabaseRepositoryError'; this.code = cause?.code || 'DATABASE_ERROR'; }
}
export function unwrap(result, operation) {
  if (result.error) throw new DatabaseRepositoryError(operation, result.error);
  return result.data;
}
