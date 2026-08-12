/**
 * 報告狀態區塊：輪詢後端 job 狀態，完成後列出下載連結。
 *
 * 下載連結一律依後端回傳的 formats 渲染——寫死 ['md','html'] 會讓之後後端新增格式時
 * 前端悄悄漏掉。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadReport, fetchReport, type ReportData } from './api';

const POLL_MS = 2000;
const TERMINAL = new Set(['done', 'empty', 'failed']);

export function ReportStatus({ reportId }: { reportId: string }): JSX.Element {
  const { t } = useTranslation();
  const [data, setData] = useState<ReportData | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await fetchReport(reportId);
        if (cancelled) return;
        setData(next);
        // 終態即停止輪詢，避免對已完成的報告持續打 API
        if (!TERMINAL.has(next.status)) timer = setTimeout(poll, POLL_MS);
      } catch {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reportId]);

  if (!data) return <div className="report-status">{t('report.starting')}</div>;

  if (data.status === 'failed') {
    return <div className="report-status report-status--error">{t('report.failed')}</div>;
  }
  if (data.status === 'empty') {
    return <div className="report-status">{t('report.empty')}</div>;
  }
  if (data.status === 'done') {
    return (
      <div className="report-status">
        <span>{t('report.ready')}</span>
        {data.formats.map((format) => (
          <button
            key={format}
            type="button"
            onClick={() => void downloadReport(data.id, format)}
          >
            {format.toUpperCase()}
          </button>
        ))}
      </div>
    );
  }

  const progress =
    data.totalSections === undefined
      ? t('report.outlining')
      : `${data.doneSections} / ${data.totalSections}`;
  return <div className="report-status">{`${t('report.working')} ${progress}`}</div>;
}
