import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationFeed } from '@hyagent/shared';
import { api } from './api';

export function useNotifications(identity: string) {
  const [feed, setFeed] = useState<NotificationFeed>({ items: [], unreadCount: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const writing = useRef(false);
  const owner = useRef(identity);
  owner.current = identity;
  const refresh = useCallback(async () => {
    if (!identity || writing.current) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const data = await api.listNotifications();
      if (generation.current === current && owner.current === identity) { setFeed(data); setError(false); }
    } catch {
      if (generation.current === current && owner.current === identity) setError(true);
    } finally {
      if (generation.current === current && owner.current === identity) setLoading(false);
    }
  }, [identity]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => {
    setFeed({ items: [], unreadCount: 0 });
    setError(false);
    setSaving(false);
    writing.current = false;
    void refresh();
    if (!identity) return;
    const poll = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(poll, 60_000);
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', poll);
    return () => {
      invalidate();
      window.clearInterval(timer);
      window.removeEventListener('focus', poll);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [identity, refresh, invalidate]);
  const markRead = async (ids: string[]) => {
    if (!identity || writing.current || !ids.length) return;
    const current = ++generation.current;
    writing.current = true;
    setLoading(false);
    setSaving(true);
    try {
      await api.markNotificationsRead(ids);
      if (owner.current !== identity || generation.current !== current) return;
      setFeed((previous) => {
        const items = previous.items.map((item) => ids.includes(item.id) ? { ...item, read: true } : item);
        return { items, unreadCount: items.filter((item) => !item.read).length };
      });
      setError(false);
    } catch (err) {
      if (owner.current === identity && generation.current === current) setError(true);
      throw err;
    } finally {
      if (owner.current === identity && generation.current === current) { writing.current = false; setSaving(false); }
    }
  };
  return { feed, loading, error, saving, refresh, markRead };
}
