import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();
const TYPE = { '-1': 'DELETE', 0: 'EQUAL', 1: 'INSERT' };
export function formatDiffForDisplay(diffs) { return diffs.map(([op, text]) => ({ type: TYPE[op], text })); }
function boundedDisplayDiffs(diffs, limit = 12000) {
  let remaining = limit; const displayDiffs = [];
  for (const [op, text] of diffs) {
    if (remaining <= 0) break;
    const visible = text.slice(0, remaining); if (visible) displayDiffs.push([op, visible]); remaining -= visible.length;
  }
  if (remaining <= 0) displayDiffs.push([0, '\n… Visual diff truncated for performance.']);
  return displayDiffs;
}
function formatDiffText(diffs) {
  const lines = diffs.flatMap(([op, text]) => text.split('\n').map((line) => ({ op, line }))).filter(({ line }) => line.trim());
  const changed = lines.map(({ op }, index) => op !== 0 ? index : -1).filter((index) => index >= 0);
  if (!changed.length) return '';
  const included = new Set();
  changed.forEach((index) => { for (let cursor = Math.max(0, index - 20); cursor <= Math.min(lines.length - 1, index + 20); cursor += 1) included.add(cursor); });
  let previous = -2; const output = [];
  [...included].sort((a, b) => a - b).forEach((index) => { if (index > previous + 1) output.push(' … Context omitted for readability'); const { op, line } = lines[index]; output.push(`${op === 1 ? '+' : op === -1 ? '-' : ' '}${line}`); previous = index; });
  return output.join('\n');
}
export function computeDiff(oldText = '', newText = '') {
  const diffs = dmp.diff_main(oldText, newText); dmp.diff_cleanupSemantic(diffs);
  const hasDiff = diffs.some(([op]) => op !== 0);
  const addedCount = diffs.filter(([op]) => op === 1).reduce((n, [, text]) => n + text.length, 0);
  const removedCount = diffs.filter(([op]) => op === -1).reduce((n, [, text]) => n + text.length, 0);
  let diffText = formatDiffText(diffs);
  if (diffText.length > 3000) diffText = `${diffText.slice(0, 2960)}\n… Diff truncated at 3000 characters`;
  return { hasDiff, diffs, displayDiffs: boundedDisplayDiffs(diffs), addedCount, removedCount, diffText };
}
