export async function callGeminiAnalyst(diffText, url, label) {
  let response;
  try {
    response = await fetch('/api/analyze-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diffText, url, label }),
    });
  } catch {
    throw new Error('Unable to reach the ARGUS Analyst service');
  }

  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`ARGUS Analyst returned an invalid response (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(data?.error || `ARGUS Analyst request failed (HTTP ${response.status})`);
  return data;
}
