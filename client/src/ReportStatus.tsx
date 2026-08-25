/**
 * 報告狀態：附在觸發報告的那則小幫手訊息下方的膠囊按鈕，點開彈窗選格式下載。
 *
 * 為什麼是彈窗而不是常駐區塊：下載選項一直攤在訊息串下方會讓那塊愈積愈雜（同一段對話
 * 可能產生多份報告）。膠囊按鈕留在它所屬的那則訊息旁，隨對話捲動、語意也對得上；
 * 彈窗關掉後仍可再點開，不必重新產生報告。
 *
 * 下載選項一律依後端回傳的 files 渲染——寫死 ['md','html'] 會讓之後後端新增格式時
 * 前端悄悄漏掉；檔名同樣一律採後端算好的值（見 downloadReport 的說明），不自行拼湊。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@hyagent/ui';
import { ApiError, downloadReport, fetchReport, type ReportData } from './api';

const POLL_MS = 2000;
const TERMINAL = new Set(['done', 'empty', 'failed']);
// 連續輪詢失敗達此次數即放棄，避免伺服器重佈（jobs Map 為記憶體態、file 後端產出物
// 也隨之消失）後 GET /api/reports/:id 恆回 404，前端卻無限重排、長期吃掉租戶限流額度
const MAX_CONSECUTIVE_FAILURES = 3;

/** 產生中的動態指示：旋轉的弧線（沿用設計系統既有的 spin 動畫） */
function WorkingIcon(): JSX.Element {
  return (
    <svg
      className="report-action-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

/** 完成／其他狀態：文件圖示，與同一列的複製圖示同尺寸同筆畫 */
function DocumentIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** 三點跳動：彈窗內表示產生中，沿用小幫手「思考中」的視覺語彙 */
function WorkingDots(): JSX.Element {
  return (
    <span className="report-chip-dots" aria-hidden>
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  );
}

export function ReportStatus({ reportId }: { reportId: string }): JSX.Element {
  const { t } = useTranslation();
  const [data, setData] = useState<ReportData | null>(null);
  // 輪詢已放棄（連續失敗過多，或收到 404 代表報告已不存在）：停止輪詢並提示使用者，
  // 而不是讓畫面永遠停在「報告產生中…」
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState(false);
  /*
   * 開啟彈窗時重跑一次輪詢用的計數器。
   *
   * 輪詢收到終態就停止，而那一次拿到的清單有可能是殘缺的：狀態端點在 job 不在該行程
   * 記憶體時，是以「目前有哪些產出物」推斷狀態的，pdf 是最後產、也最慢產的一個。
   * 少了這個重查，那則訊息的下載清單會被第一次的快照永久凍結——使用者看不到後來才
   * 產好的 PDF，後台卻列得出來。彈窗是使用者唯一會主動觸發的時機，重查成本一次請求。
   */
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // 重查等於一次重試：先清掉上一輪的放棄旗標，否則查得到了畫面仍停在「報告已失效」
    setStale(false);

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
  }, [reportId, refreshKey]);

  const status = stale ? 'stale' : (data?.status ?? 'queued');
  const isWorking = !stale && !TERMINAL.has(status);
  const files = data?.files ?? [];

  // 膠囊上的文字：產生中帶真實節數（大綱未拆完時 totalSections 還沒有值，改顯示規劃中）
  const progress =
    data?.totalSections === undefined
      ? t('report.outlining')
      : `${data.doneSections} / ${data.totalSections}`;

  const chipLabel = (): string => {
    if (stale) return t('report.stale');
    if (status === 'failed') return t('report.failed');
    if (status === 'empty') return t('report.empty');
    if (status === 'done') return t('report.view');
    return `${t('report.working')} ${progress}`;
  };

  const dialogBody = (): JSX.Element => {
    if (stale) return <p>{t('report.stale')}</p>;
    if (status === 'failed') return <p>{t('report.failed')}</p>;
    if (status === 'empty') return <p>{t('report.empty')}</p>;
    if (status !== 'done') {
      return (
        <p className="report-dialog-working">
          <WorkingDots />
          {`${t('report.working')} ${progress}`}
        </p>
      );
    }
    return (
      <>
        <p>{t('report.pickFormat')}</p>
        <div className="report-formats">
          {files.map((file) => (
            <button
              key={file.format}
              type="button"
              className="report-download"
              onClick={() => void downloadReport(reportId, file.format, file.filename)}
            >
              <span className="report-format-name">{file.format.toUpperCase()}</span>
              <span className="report-format-file">{file.filename}</span>
            </button>
          ))}
        </div>
      </>
    );
  };

  // 圖示按鈕不帶可見文字，狀態全靠 title / aria-label 傳達
  const label = chipLabel();

  return (
    <>
      <button
        type="button"
        className={`msg-action report-action${status === 'failed' || stale ? ' report-action--error' : ''}`}
        title={label}
        aria-label={label}
        onClick={() => {
          setOpen(true);
          setRefreshKey((n) => n + 1);
        }}
      >
        {isWorking ? <WorkingIcon /> : <DocumentIcon />}
      </button>

      <Dialog
        isOpen={open}
        title={t('report.dialogTitle')}
        hideCancel
        confirmText={t('report.close')}
        onClose={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      >
        {dialogBody()}
      </Dialog>
    </>
  );
}
