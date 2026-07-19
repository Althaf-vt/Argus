import { useCallback, useEffect, useRef, useState } from 'react';
import { extractReadableText } from '../lib/extractor';
import { computeDiff } from '../lib/differ';
import { callGeminiAnalyst } from '../lib/gemini';
import { commitChange, getSnapshot, recoverPendingChange, saveSnapshot } from '../lib/storage';

const initial = { fetcher: 'IDLE', differ: 'IDLE', analyst: 'IDLE', notifier: 'IDLE' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function useArgusCheck({ urlConfig, onComplete, onStatus, notify }) {
  const [agentStatuses, setAgentStatuses] = useState(initial);
  const [isRunning, setIsRunning] = useState(false);
  const statusesRef = useRef(initial);
  const runningIdsRef = useRef(new Set());
  const handlersRef = useRef({ onComplete, onStatus, notify });
  useEffect(() => { handlersRef.current = { onComplete, onStatus, notify }; }, [onComplete, onStatus, notify]);
  const setAgent = (name, status) => setAgentStatuses((all) => { const next = { ...all, [name]: status }; statusesRef.current = next; return next; });

  const runCheck = useCallback(async (targetConfig = urlConfig) => {
    if (!targetConfig || runningIdsRef.current.has(targetConfig.id)) return;
    runningIdsRef.current.add(targetConfig.id);
    setIsRunning(true); statusesRef.current = initial; setAgentStatuses(initial);
    handlersRef.current.onStatus?.('CHECKING', new Date().toISOString(), targetConfig);
    try {
      recoverPendingChange(targetConfig.id);
      setAgent('fetcher', 'RUNNING'); const started = Date.now();
      const response = await fetch('/api/fetch-page', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: targetConfig.url }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Fetch failed');
      await pause(Math.max(0, 400 - (Date.now() - started))); setAgent('fetcher', 'COMPLETE');
      setAgent('differ', 'RUNNING'); const differStarted = Date.now(); const text = extractReadableText(data.html, { filterNoise: targetConfig.filterNoise !== false }); const previous = getSnapshot(targetConfig.id);
      if (!previous) { saveSnapshot(targetConfig.id, text); await pause(Math.max(0, 400 - (Date.now() - differStarted))); setAgent('differ', 'COMPLETE'); handlersRef.current.onStatus?.('NO_CHANGE', data.fetchedAt, targetConfig); handlersRef.current.onComplete?.({ changed: false, baseline: true, urlConfig: targetConfig }); return { changed: false, baseline: true }; }
      const diff = computeDiff(previous, text); await pause(Math.max(0, 400 - (Date.now() - differStarted))); setAgent('differ', 'COMPLETE');
      if (!diff.hasDiff) { saveSnapshot(targetConfig.id, text); handlersRef.current.onStatus?.('NO_CHANGE', data.fetchedAt, targetConfig); handlersRef.current.onComplete?.({ changed: false, diff, urlConfig: targetConfig }); return { changed: false, diff }; }
      setAgent('analyst', 'RUNNING'); const analystStarted = Date.now(); const analysis = await callGeminiAnalyst(diff.diffText, targetConfig.url, targetConfig.label); await pause(Math.max(0, 400 - (Date.now() - analystStarted))); setAgent('analyst', 'COMPLETE');
      setAgent('notifier', 'RUNNING');
      const event = { id: crypto.randomUUID(), detectedAt: data.fetchedAt, ...analysis, diffSnippet: diff.diffText.slice(0, 500), visualDiff: { diffs: diff.diffs, displayDiffs: diff.displayDiffs, addedCount: diff.addedCount, removedCount: diff.removedCount } };
      commitChange(targetConfig.id, text, event); await pause(400); setAgent('notifier', 'COMPLETE');
      if (['HIGH', 'CRITICAL'].includes(analysis.severity)) handlersRef.current.notify?.(`ARGUS · ${analysis.severity}`, analysis.summary);
      handlersRef.current.onStatus?.('CHANGE_DETECTED', data.fetchedAt, targetConfig); handlersRef.current.onComplete?.({ changed: true, analysis, diff, event, urlConfig: targetConfig }); return { changed: true, analysis, diff };
    } catch (error) {
      const active = Object.entries(statusesRef.current).find(([, status]) => status === 'RUNNING')?.[0] || 'fetcher'; setAgent(active, 'ERROR'); handlersRef.current.onStatus?.('ERROR', new Date().toISOString(), targetConfig); handlersRef.current.onComplete?.({ changed: false, error: error.message, urlConfig: targetConfig }); return { changed: false, error: error.message };
    } finally { runningIdsRef.current.delete(targetConfig.id); setIsRunning(runningIdsRef.current.size > 0); }
  }, [urlConfig]);
  return { agentStatuses, runCheck, isRunning };
}
