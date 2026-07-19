export const monitorIntervals = { '15m': 15 * 60 * 1000, '30m': 30 * 60 * 1000, '1h': 60 * 60 * 1000, '4h': 4 * 60 * 60 * 1000 };

export function getMonitorInterval(interval, developmentOverrideMs) {
  const configured = monitorIntervals[interval];
  return configured && developmentOverrideMs ? developmentOverrideMs : configured;
}

export function getNextCheckAt(item, interval, now = Date.now()) {
  if (item.nextCheckAt) return new Date(item.nextCheckAt).getTime();
  return new Date(item.lastCheckedAt || item.addedAt || now).getTime() + interval;
}

// Framework-agnostic and keyed: one timer per URL, independently scheduled.
export function createMonitorScheduler({ setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const timers = new Map();
  const cancel = (id) => { const timer = timers.get(id); if (timer !== undefined) clearTimer(timer); timers.delete(id); };
  return {
    schedule(id, at, callback) { cancel(id); timers.set(id, setTimer(() => { timers.delete(id); callback(); }, Math.max(0, at - now()))); },
    cancel,
    cancelAll() { [...timers.keys()].forEach(cancel); },
  };
}
