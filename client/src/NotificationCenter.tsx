import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@hyagent/ui';
import type { TaskNotification } from '@hyagent/shared';
import type { useNotifications } from './useNotifications';
import './taskCenter.css';

export default function NotificationCenter({ notifications, onOpen }: {
  notifications: ReturnType<typeof useNotifications>;
  onOpen: (item: TaskNotification) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const { feed, loading, error, saving, refresh, markRead } = notifications;
  const items = feed.items.filter((item) => !unreadOnly || !item.read);
  const busy = opening || saving;
  async function open(item: TaskNotification) {
    setOpening(true);
    setOpenError(false);
    try {
      if (!item.read) await markRead([item.id]);
      await onOpen(item);
    } catch { setOpenError(true); }
    finally { setOpening(false); }
  }
  return <main className="task-center" aria-labelledby="notification-title"><div className="task-center-inner">
    <div className="task-heading"><div><h1 id="notification-title">{t('notifications.title')}</h1><p>{t('notifications.description')}</p></div></div>
    <div className="task-toolbar notification-toolbar">
      <button className={`quick-chip${!unreadOnly ? ' active' : ''}`} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>{t('notifications.all')}</button>
      <button className={`quick-chip${unreadOnly ? ' active' : ''}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>{t('notifications.unread')} ({feed.unreadCount})</button>
      <button className="quick-chip" disabled={busy || loading || !feed.unreadCount} onClick={() => { void markRead(feed.items.filter((item) => !item.read).map((item) => item.id)).catch(() => {}); }}>{t('notifications.readAll')}</button>
      <Button variant="reset" size="md" disabled={busy || loading} onClick={() => void refresh()}>{t('tasks.refresh')}</Button>
    </div>
    {(error || openError) && <p className="task-error" role="alert">{t(openError ? 'notifications.openError' : 'notifications.error')}</p>}
    {loading && <p role="status">{t('notifications.loading')}</p>}
    {!loading && !error && !items.length && <div className="task-empty"><h2>{t(unreadOnly ? 'notifications.allCaughtUp' : 'notifications.empty')}</h2><p>{t('notifications.emptyHint')}</p></div>}
    <section aria-label={t('notifications.title')}>
      {items.map((item) => <article key={item.id} className={`task-card notification-card${item.read ? '' : ' is-unread'}`}>
        <div className="task-card-body">
          <p className="notification-kind">{!item.read && <span className="notification-dot" aria-label={t('notifications.unread')} />}{t(`notifications.kinds.${item.kind}`)}</p>
          <h2>{item.title}</h2><p>{t(`notifications.hints.${item.kind}`)}</p>
          <p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(i18n.language)}</time></p>
        </div>
        <div className="task-actions">
          <button className="quick-chip active" disabled={busy} onClick={() => void open(item)}>{t('notifications.open')}</button>
          {!item.read && <button className="quick-chip" disabled={busy} onClick={() => { void markRead([item.id]).catch(() => {}); }}>{t('notifications.markRead')}</button>}
        </div>
      </article>)}
    </section>
  </div></main>;
}
