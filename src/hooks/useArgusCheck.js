import { useCallback, useEffect, useRef, useState } from 'react';

const initial = { fetcher: 'IDLE', differ: 'IDLE', analyst: 'IDLE', notifier: 'IDLE' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyFor = (target) => target?.clientKey || target?.id || null;

// Pipeline cards are runtime-only UI state. They are deliberately keyed per target
// and never restored from scan history.
export function useArgusCheck({ urlConfig, onComplete, onStatus, notify }) {
  const [statusesByTarget, setStatusesByTarget] = useState({});
  const [runningKeys, setRunningKeys] = useState([]);
  const handlers = useRef({ onComplete, onStatus, notify });
  const running = useRef(new Set());
  const statuses = useRef({});
  useEffect(() => { handlers.current = { onComplete, onStatus, notify }; }, [onComplete, onStatus, notify]);
  const setAgent = (targetKey, name, status) => setStatusesByTarget((all) => {
    const next = { ...all, [targetKey]: { ...(all[targetKey] || initial), [name]: status } };
    statuses.current = next;
    return next;
  });
  const runCheck = useCallback(async (target = urlConfig) => {
    const targetKey = keyFor(target);
    if (!target || !targetKey || running.current.has(targetKey)) return;
    running.current.add(targetKey); setRunningKeys([...running.current]);
    statuses.current = { ...statuses.current, [targetKey]: initial }; setStatusesByTarget((all) => ({ ...all, [targetKey]: initial }));
    handlers.current.onStatus?.('CHECKING', new Date().toISOString(), target);
    try {
      setAgent(targetKey, 'fetcher', 'RUNNING'); await pause(180); setAgent(targetKey, 'fetcher', 'COMPLETE');
      setAgent(targetKey, 'differ', 'RUNNING'); await pause(180); setAgent(targetKey, 'differ', 'COMPLETE');
      setAgent(targetKey, 'analyst', 'RUNNING');
      const response = await fetch('/api/monitor/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: target.url, label: target.label || '', filterNoise: target.filterNoise !== false }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Authoritative check failed');
      setAgent(targetKey, 'analyst', result.outcome === 'CHANGE_DETECTED' ? 'COMPLETE' : 'IDLE'); setAgent(targetKey, 'notifier', 'RUNNING'); await pause(180); setAgent(targetKey, 'notifier', 'COMPLETE');
      const changed = result.outcome === 'CHANGE_DETECTED'; if (changed && ['HIGH', 'CRITICAL'].includes(result.analysis.severity)) handlers.current.notify?.(`ARGUS · ${result.analysis.severity}`, result.analysis.summary);
      handlers.current.onStatus?.(changed ? 'CHANGE_DETECTED' : 'NO_CHANGE', result.target.lastCheckedAt, { ...target, ...result.target });
      handlers.current.onComplete?.({ changed, baseline: result.outcome === 'BASELINE', analysis: result.analysis, diff: result.diff, event: result.event, target: result.target, urlConfig: { ...target, ...result.target } });
      return result;
    } catch (error) {
      const active = Object.entries(statuses.current[targetKey] || initial).find(([, status]) => status === 'RUNNING')?.[0] || 'fetcher';
      setAgent(targetKey, active, 'ERROR'); handlers.current.onStatus?.('ERROR', new Date().toISOString(), target); handlers.current.onComplete?.({ changed: false, error: error.message, urlConfig: target }); return { error: error.message };
    } finally { running.current.delete(targetKey); setRunningKeys([...running.current]); }
  }, [urlConfig]);
  const selectedKey = keyFor(urlConfig);
  return { agentStatuses: selectedKey ? statusesByTarget[selectedKey] || initial : initial, runCheck, isRunning: Boolean(selectedKey && runningKeys.includes(selectedKey)) };
}
