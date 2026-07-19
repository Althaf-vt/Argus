import { createEntireWebsiteTarget } from '../../server/services/entire-website-discovery.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { url, label = '', filterNoise = true } = req.body || {};
  if (typeof url !== 'string' || url.length > 2048 || typeof label !== 'string' || label.length > 240 || typeof filterNoise !== 'boolean') return res.status(400).json({ error: 'A valid root URL and settings are required' });
  try { return res.status(201).json({ target: await createEntireWebsiteTarget({ url, label, filterNoise }) }); } catch (error) { return res.status(502).json({ error: /^(Only public|Private|Destination resolves|Target |Request timed out|DISCOVERY_)/.test(error?.message || '') ? error.message : 'Unable to complete initial website discovery' }); }
}
