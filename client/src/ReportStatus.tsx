/**
 * 報告狀態區塊：輪詢後端 job 狀態，完成後列出下載連結。
 *
 * 下載連結一律依後端回傳的 files 渲染——寫死 ['md','html'] 會讓之後後端新增格式時
 * 前端悄悄漏掉；檔名同樣一律採後端算好的值（見 downloadReport 的說明），不自行拼湊。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, downloadReport, fetchReport, type ReportData } from './api';

const POLL_MS = 2000;
const TERMINAL = new Set(['done', 'empty', 'failed']);
// 連續輪詢失敗達此次數即放棄，避免伺服器重佈（jobs Map 為記憶體態、file 後端產出物
// 也隨之消失）後 GET /api/reports/:id 恆回 404，前端卻無限重排、長期吃掉租戶限流額度
const MAX_CONSECUTIVE_FAILURES = 3;

export function ReportStatus({ reportId }: { reportId: string }): JSX.Element {
  const { t } = useTranslation();
  const [data, setData] = useState<ReportData | null>(null);
  // 輪詢已放棄（連續失敗過多，或收到 404 代表報告已不存在）：停止輪詢並提示使用者，
  // 而不是讓畫面永遠停在「報告產生中…」
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const poll = async (): Promise<void> => {
      try {
        const next = await fetchReport(reportId);
        if (cancelled) return;
        failures = 0;
        setData(next);
        // 終態即停止輪詢，避免對已完成的報告持續打 API
        if (!TERMINAL.has(next.status)) timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (cancelled) return;
        failures += 1;
        // 404 代表報告已確定不存在（例如重啟後記憶體 job 與 file 後端產出物都清空），
        // 再重試也不會有結果，不必等到累積次數才放棄
        const gone = err instanceof ApiError && err.status === 404;
        if (gone || failures >= MAX_CONSECUTIVE_FAILURES) {
          setStale(true);
          return;
        }
        timer = setTimeout(poll, POLL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reportId]);

  if (stale) {
    return <div className="report-status report-status--error">{t('report.stale')}</div>;
  }

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
        {data.files.map((file) => (
          <button
            key={file.format}
            type="button"
            className="report-download"
            onClick={() => void downloadReport(data.id, file.format, file.filename)}
          >
            {file.format.toUpperCase()}
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
