import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskCenterData } from '@hyagent/shared';
import { Button } from '@hyagent/ui';
import { api } from './api';
import { ReportStatus } from './ReportStatus';
import './taskCenter.css';

type Category = keyof TaskCenterData;
const categories: Category[] = ['drafts', 'submissions', 'reports'];
const PAGE_SIZE = 20;

export default function TaskCenter({ onOpen, onNew, onCancelled, initialTarget }: {
  initialTarget?: { category: Category; id: string };
  onOpen: (id: string) => Promise<void>;
  onNew: () => void;
  onCancelled: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<TaskCenterData | null>(null);
  const [category, setCategory] = useState<Category>(initialTarget?.category ?? 'drafts');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api.listTasks().then((result) => {
      if (alive) setData(result);
    }).catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : t('tasks.loadError'));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision, t]);

  useEffect(() => {
    if (loading || !data || !initialTarget || category !== initialTarget.category) return;
    const element = document.getElementById(`task-${initialTarget.category}-${initialTarget.id}`);
    element?.scrollIntoView?.({ block: 'center' });
    element?.focus();
  }, [data, initialTarget, loading, category]);

  async function open(id: string) {
    setActing(id);
    setError('');
    try { await onOpen(id); }
    catch (err) { setError(err instanceof Error ? err.message : t('tasks.loadError')); }
    finally { setActing(null); }
  }

  async function cancel(id: string) {
    setActing(id);
    setError('');
    try {
      await api.cancelTask(id);
      setData((current) => current ? { ...current, drafts: current.drafts.filter((d) => d.id !== id) } : current);
      setCancelId(null);
      onCancelled(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tasks.cancelError'));
    } finally { setActing(null); }
  }

  const term = query.trim().toLocaleLowerCase();
  const matching = (title: string, reference = '') => `${title} ${reference}`.toLocaleLowerCase().includes(term);
  const prioritize = <T,>(items: T[], idOf: (item: T) => string) => initialTarget ? [...items].sort((a, b) => Number(idOf(b) === initialTarget.id) - Number(idOf(a) === initialTarget.id)) : items;
  const drafts = prioritize(data?.drafts.filter((d) => matching(d.title)) ?? [], (d) => d.id);
  const submissions = prioritize(data?.submissions.filter((s) => matching(s.title, s.oaRequestId)) ?? [], (s) => s.oaRequestId);
  const reports = prioritize(data?.reports.filter((r) => matching(r.title)) ?? [], (r) => r.id);
  const count = { drafts: drafts.length, submissions: submissions.length, reports: reports.length }[category];
  const formatDate = (iso: string) => new Date(iso).toLocaleString(i18n.language, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const disabled = loading || acting !== null;

  return (
    <main className="task-center" aria-labelledby="task-title">
      <div className="task-center-inner">
        <div className="task-heading">
          <div><h1 id="task-title">{t('tasks.title')}</h1><p>{t('tasks.description')}</p></div>
          <button className="quick-chip" onClick={onNew} disabled={disabled}>{t('tasks.newTask')}</button>
        </div>
        <div className="task-categories" aria-label={t('tasks.categories')}>
          {categories.map((key) => (
            <button key={key} className={`task-category${category === key ? ' active' : ''}`}
              aria-pressed={category === key} disabled={acting !== null}
              onClick={() => { setCategory(key); setLimit(PAGE_SIZE); setCancelId(null); }}>
              <span>{t(`tasks.${key}`)}</span><strong>{data?.[key].length ?? '—'}</strong>
            </button>
          ))}
        </div>
        <div className="task-toolbar">
          <input type="search" value={query} aria-label={t('tasks.search')} placeholder={t('tasks.search')}
            onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE); }} />
          <Button
            type="button"
            variant="reset"
            size="md"
            className="shrink-0 self-center"
            disabled={disabled}
            onClick={() => setRevision((v) => v + 1)}
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            }
          >
            {t('tasks.refresh')}
          </Button>
        </div>
        {error && <div className="task-error" role="alert">{error}</div>}
        {loading && <p role="status" className="task-empty">{t('tasks.loading')}</p>}
        {!loading && data && (
          <section aria-label={t(`tasks.${category}`)}>
            {category === 'submissions' && count > 0 && <p className="task-note">{t('tasks.approvalNote')}</p>}
            {count === 0 && <div className="task-empty"><h2>{t(query ? 'tasks.noResults' : `tasks.empty.${category}`)}</h2>
              <p>{t(query ? 'tasks.searchHint' : 'tasks.emptyHint')}</p></div>}
            {category === 'drafts' && drafts.slice(0, limit).map((draft) => (
              <article id={`task-drafts-${draft.id}`} tabIndex={-1} className="task-card" key={draft.id}>
                <div className="task-card-body"><h2>{draft.title}</h2>
                  <p><time dateTime={draft.updatedAt}>{formatDate(draft.updatedAt)}</time> · {t(`app.status.${draft.status}`)}</p>
                  {!draft.canResume && <p>{t(draft.status === 'submitting' ? 'tasks.submittingHint' : draft.status === 'failed' ? 'tasks.failedHint' : 'tasks.unavailable')}</p>}
                </div>
                <div className="task-actions">
                  {cancelId === draft.id ? <>
                    <span>{t('tasks.cancelConfirm')}</span>
                    <button className="quick-chip" disabled={disabled} onClick={() => void cancel(draft.id)}>{t('tasks.confirmCancel')}</button>
                    <button className="quick-chip" disabled={disabled} onClick={() => setCancelId(null)}>{t('tasks.keep')}</button>
                  </> : <>
                    {draft.canResume && <button className="quick-chip active" disabled={disabled} onClick={() => void open(draft.id)}>{t('tasks.resume')}</button>}
                    {draft.canCancel && <button className="quick-chip" disabled={disabled} onClick={() => setCancelId(draft.id)}>{t('tasks.cancel')}</button>}
                  </>}
                </div>
              </article>
            ))}
            {category === 'submissions' && submissions.slice(0, limit).map((submission) => (
              <article id={`task-submissions-${submission.oaRequestId}`} tabIndex={-1} className="task-card" key={submission.oaRequestId}>
                <div className="task-card-body"><h2>{submission.title}</h2>
                  <p>{t('tasks.reference')}: {submission.oaRequestId}</p>
                  <p><time dateTime={submission.submittedAt}>{formatDate(submission.submittedAt)}</time></p>
                </div>
                {submission.conversationId ? <button className="quick-chip" disabled={disabled} onClick={() => void open(submission.conversationId!)}>{t('tasks.details')}</button>
                  : <span className="task-note">{t('tasks.recordOnly')}</span>}
              </article>
            ))}
            {category === 'reports' && reports.slice(0, limit).map((report) => (
              <article id={`task-reports-${report.id}`} tabIndex={-1} className="task-card" key={report.id}>
                <div className="task-card-body"><h2>{report.title}</h2><p><time dateTime={report.createdAt}>{formatDate(report.createdAt)}</time></p></div>
                <ReportStatus reportId={report.id} showLabel />
              </article>
            ))}
            {count > limit && <button className="quick-chip task-more" onClick={() => setLimit((v) => v + PAGE_SIZE)}>{t('tasks.more')}</button>}
          </section>
        )}
        {acting && <p role="status">{t('tasks.working')}</p>}
      </div>
    </main>
  );
}
