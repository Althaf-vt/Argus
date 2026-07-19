import { useCallback, useState } from 'react';
export function useNotifications() {
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  const requestPermission = useCallback(async () => { if (!('Notification' in window)) return 'unsupported'; const next = await Notification.requestPermission(); setPermission(next); return next; }, []);
  const send = useCallback((title, body) => { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); }, []);
  return { permission, requestPermission, send };
}
