import crypto from 'node:crypto';
import { dispatchDueSpecificPageScans } from '../../server/services/specific-page-monitor.js';
import { dispatchDueEntireWebsiteRediscoveries } from '../../server/services/entire-website-rediscovery.js';

const equal = (left, right) => {
  const a = globalThis.Buffer.from(left || ''); const b = globalThis.Buffer.from(right || '');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = globalThis.process?.env?.ARGUS_CRON_SECRET;
  if (!secret || !equal(req.headers?.['x-argus-cron-secret'], secret)) return res.status(401).json({ error: 'Unauthorized' });
  try { const [specificPages, entireWebsites] = await Promise.allSettled([dispatchDueSpecificPageScans(5), dispatchDueEntireWebsiteRediscoveries(2)]); return res.status(200).json({ specificPages: specificPages.status === 'fulfilled' ? specificPages.value : { error: 'FAILED' }, entireWebsites: entireWebsites.status === 'fulfilled' ? entireWebsites.value : { error: 'FAILED' } }); } catch { return res.status(503).json({ error: 'Scheduled dispatcher unavailable' }); }
}
