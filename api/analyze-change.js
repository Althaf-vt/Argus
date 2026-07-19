const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const requests = new Map();
const rateWindowMs = 10 * 60 * 1000;
const rateLimit = 12;

const schema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    severity: { type: 'STRING', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    areas_affected: { type: 'ARRAY', items: { type: 'STRING' } },
    recommended_action: { type: 'STRING' },
    reasoning: { type: 'STRING' },
  },
  required: ['summary', 'severity', 'areas_affected', 'recommended_action', 'reasoning'],
};

const buildAnalystPrompt = (url, label, diffText) => `You are ARGUS Analyst, an AI agent specialized in understanding the business significance of website changes.

A website is being monitored: ${label ? `"${label}" at ` : ''}${url}

Changes (new lines start +; removed lines start -):
${diffText}

Respond ONLY with valid JSON in exactly this shape:
{"summary":"One sentence in plain English","severity":"LOW | MEDIUM | HIGH | CRITICAL","areas_affected":["content areas"],"recommended_action":"One concrete user action","reasoning":"2-3 sentences explaining the severity"}

Severity: LOW cosmetic/minor edits; MEDIUM content or feature updates; HIGH pricing, policy, or availability changes; CRITICAL major price drops, discontinuations, or major policy shifts requiring immediate response. No markdown fences or extra text.`;

const describeResponse = (data) => {
  if (!data || typeof data !== 'object') return `top-level=${typeof data}`;
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  const partShapes = Array.isArray(candidate?.content?.parts) ? candidate.content.parts.map((part) => Object.keys(part || {}).join('|') || 'empty').join(', ') : typeof candidate?.content?.parts;
  return `candidates=${Array.isArray(data.candidates) ? data.candidates.length : 'missing'}, finishReason=${candidate?.finishReason || 'missing'}, firstCandidateParts=${partShapes || 'none'}`;
};

const parseJson = (text) => {
  const clean = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Gemini did not return a JSON object');
  return JSON.parse(clean.slice(start, end + 1));
};

const extractCandidateJson = (data) => {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Gemini blocked the prompt (${blockReason})` : `Gemini returned no candidates (${describeResponse(data)})`);
  }
  if (candidate.finishReason === 'MAX_TOKENS') throw new Error('Gemini response was truncated before the Analyst JSON completed (finishReason=MAX_TOKENS)');
  if (candidate.finishReason && candidate.finishReason !== 'STOP') throw new Error(`Gemini stopped without a usable Analyst response (finishReason=${candidate.finishReason})`);
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) throw new Error(`Gemini response has no candidates[0].content.parts (${describeResponse(data)})`);
  const textParts = parts.filter((part) => typeof part?.text === 'string');
  const texts = [...textParts.filter((part) => !part.thought), ...textParts.filter((part) => part.thought)].map((part) => part.text);
  for (const text of texts) { try { return parseJson(text); } catch { /* Try every text part. */ } }
  try { return parseJson(texts.join('\n')); } catch { throw new Error(`Gemini response contained no parseable JSON in candidates[0].content.parts (${describeResponse(data)})`); }
};

const normalizeAnalysis = (analysis) => {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) throw new Error('Gemini JSON response must be an object');
  const text = (field) => {
    const value = analysis[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Gemini JSON field "${field}" must be a non-empty string`);
    return value.trim();
  };
  const severity = text('severity').toUpperCase();
  if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity)) throw new Error('Gemini JSON field "severity" must be LOW, MEDIUM, HIGH, or CRITICAL');
  if (!Array.isArray(analysis.areas_affected) || analysis.areas_affected.some((area) => typeof area !== 'string')) throw new Error('Gemini JSON field "areas_affected" must be an array of strings');
  return { summary: text('summary'), severity, areas_affected: analysis.areas_affected.map((area) => area.trim()).filter(Boolean), recommended_action: text('recommended_action'), reasoning: text('reasoning') };
};

const clientKey = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || 'anonymous').split(',')[0].trim();
};
const isRateLimited = (key) => {
  const now = Date.now(); const recent = (requests.get(key) || []).filter((time) => now - time < rateWindowMs);
  if (recent.length >= rateLimit) { requests.set(key, recent); return true; }
  recent.push(now); requests.set(key, recent); return false;
};

export default async function handler(req, res) {
  Object.entries(cors).forEach(([key, value]) => res.setHeader(key, value));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (isRateLimited(clientKey(req))) return res.status(429).json({ error: 'Too many analysis requests. Please try again later.' });
  const { diffText, url, label = '' } = req.body || {};
  if (typeof diffText !== 'string' || !diffText.trim() || typeof url !== 'string') return res.status(400).json({ error: 'A URL and change diff are required' });
  const key = globalThis.process?.env?.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'Gemini service is not configured' });

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildAnalystPrompt(url, label, diffText.slice(0, 3000)) }] }], generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'minimal' }, responseMimeType: 'application/json', responseSchema: schema } }),
    });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { return res.status(502).json({ error: `Gemini returned an invalid response (HTTP ${response.status})` }); }
    if (!response.ok) {
      const code = data?.error?.code || response.status;
      const message = typeof data?.error?.message === 'string' ? data.error.message : 'Gemini API request failed';
      return res.status(502).json({ error: `Gemini API error (HTTP ${response.status}, code ${code}): ${message}` });
    }
    return res.status(200).json(normalizeAnalysis(extractCandidateJson(data)));
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Gemini analysis failed' });
  }
}
