export function exportHistoryAsMarkdown(urlConfig, history) {
  const title = urlConfig.label || urlConfig.url;
  const body = ['# ARGUS Change Report', '', `- **Target:** ${title}`, `- **URL:** ${urlConfig.url}`, `- **Generated:** ${new Date().toISOString()}`, '', '## Change history', ''];
  if (!history.length) body.push('_No change events have been recorded._');
  history.forEach((event) => body.push(`### ${event.severity} — ${event.detectedAt}`, '', event.summary, '', `**Areas affected:** ${event.areas_affected.join(', ') || 'Not specified'}`, '', `**Recommended action:** ${event.recommended_action}`, '', `**Reasoning:** ${event.reasoning}`, '', '```diff', event.diffSnippet || '', '```', ''));
  const blob = new Blob([body.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const href = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = href; anchor.download = `argus-${urlConfig.id}-history.md`; anchor.click(); URL.revokeObjectURL(href);
}
