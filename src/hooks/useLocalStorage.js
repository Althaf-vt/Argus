import { useCallback, useState } from 'react';
export function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => { try { const item = localStorage.getItem(key); return item ? JSON.parse(item) : initialValue; } catch { return initialValue; } });
  const setStoredValue = useCallback((next) => setValue((current) => { const resolved = typeof next === 'function' ? next(current) : next; localStorage.setItem(key, JSON.stringify(resolved)); return resolved; }), [key]);
  return [value, setStoredValue];
}
