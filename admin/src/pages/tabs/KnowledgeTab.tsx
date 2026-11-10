import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  api,
  type IngestJob,
  type KnowledgeAclReport,
  type KnowledgeLabel,
  type KnowledgeMeta,
  type KnowledgeSource,
} from "../../api";
import { useUnsavedChanges } from "../../components/unsaved";
import { sourceNeedsAclWarning } from "./knowledgeAcl.util";
import AccessPanel from "./knowledge/AccessPanel";
import FilesCard from "./knowledge/FilesCard";
import IndexStatusCard from "./knowledge/IndexStatusCard";
import PromptsPanel from "./knowledge/PromptsPanel";
import SourceCard from "./knowledge/SourceCard";
import TestPanel from "./knowledge/TestPanel";

/** 知識庫子頁：一頁塞六張卡片太擠，依工作拆開；子頁寫入網址 ?kb=，可從其他頁籤直接連過來 */
type KbSub = "sources" | "access" | "prompts" | "test";
const KB_SUBS: { key: KbSub; label: string }[] = [
  { key: "sources", label: "來源與檔案" },
  { key: "access", label: "可見範圍與標籤" },
  { key: "prompts", label: "開場推薦詞" },
  { key: "test", label: "測試查詢" },
];

/**
 * 知識庫頁籤的外層：載入各子頁共用的資料（網站設定、索引 meta、解析工作、標籤、ACL 盤點、部門），
 * 負責子頁切換、解析進度輪詢、未儲存提醒與跨子頁的跳轉；各子頁的編輯狀態留在子頁元件內。
 *
 * 子頁都保持掛載、只以 hidden 切換：切到別的子頁再回來，編輯到一半的草稿（推薦詞、標籤、查詢結果）不會消失。
 */
export default function KnowledgeTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const [src, setSrc] = useState<KnowledgeSource | null>(null);
  // 最後一次載入／儲存的網站設定，用來判斷「儲存網站設定」是否還有未儲存的修改
  const [savedSrc, setSavedSrc] = useState<KnowledgeSource | null>(null);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  // 單檔上傳上限（MB）由後端 env 決定；舊版後端沒回傳時沿用 10
  const [fileMaxMb, setFileMaxMb] = useState(10);
  const [job, setJob] = useState<IngestJob | null>(null);
  const [labels, setLabels] = useState<KnowledgeLabel[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [aclReport, setAclReport] = useState<KnowledgeAclReport | null>(null);
  // 跨子頁跳轉：「可見範圍與標籤」要求開啟某份檔案的標籤編輯，由「來源與檔案」的檔案清單處理
  const [focusFileId, setFocusFileId] = useState<string | null>(null);
  // 索引被清除時遞增，讓測試查詢清掉已不代表現況的結果
  const [indexEpoch, setIndexEpoch] = useState(0);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  // 子頁：網址指定者優先；從回饋分頁帶問題（?q=）進來時直接開測試查詢
  const rawSub = searchParams.get("kb");
  const sub: KbSub = KB_SUBS.some((item) => item.key === rawSub) ? (rawSub as KbSub) : searchParams.get("q") ? "test" : "sources";
  const setSub = (next: KbSub) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    params.set("kb", next);
    return params;
  }, { replace: true });

  const load = useCallback(async () => {
    try {
      const d = await api.getKnowledge(tenantId);
      const effectiveSource = {
        ...d.source,
        embeddingModel: d.meta.model ?? d.source.embeddingModel,
      };
      setSrc(effectiveSource);
      setSavedSrc(effectiveSource);
      setMeta(d.meta);
      setJob(d.runningJob);
      if (d.fileMaxMb) setFileMaxMb(d.fileMaxMb);
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  /** 標籤清單 + ACL 盤點：兩者都是「標籤異動後要重看」的資料，合併成一次載入 */
  const loadAcl = useCallback(async () => {
    try {
      const [ls, report, policy] = await Promise.all([
        api.listKnowledgeLabels(tenantId),
        api.getKnowledgeAclReport(tenantId),
        api.getTenantPolicy(tenantId),
      ]);
      setLabels(ls);
      // 網站「指定部門」只能選一般部門：排除網站訪客與「未指定部門」兩個系統桶
      setDepartments([...new Set([...policy.departments, ...Object.keys(policy.groups)])].filter((department) => department !== "—" && department !== "__unassigned__"));
      setAclReport(report);
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  /** 索引、檔案或可見性異動後：索引與 ACL 盤點一起重看 */
  const reloadAll = useCallback(async () => {
    await Promise.all([load(), loadAcl()]);
  }, [load, loadAcl]);

  useEffect(() => {
    void load();
    void loadAcl();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [load, loadAcl]);

  /** 網站解析工作建立後輪詢進度，結束時重新載入索引 */
  const startJob = (started: IngestJob) => {
    setJob(started);
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const j = await api.getKnowledgeJob(tenantId, started.id);
        setJob(j);
        if (j.status === "done" || j.status === "failed") {
          if (poll.current) clearInterval(poll.current);
          poll.current = null;
          void load();
        }
      } catch (e) {
        onError(e);
      }
    }, 2000);
  };

  // 網站設定是唯一需要按儲存的區塊（標籤、檔案可見性、推薦詞皆立即生效）
  const sourceDirty = !!src && !!savedSrc && JSON.stringify(src) !== JSON.stringify(savedSrc);
  useUnsavedChanges("知識庫：網站設定", sourceDirty);
  // 「可見範圍與標籤」子頁的待處理數：未標記檔案＋網站未設定可查詢對象
  const accessWarnings = (aclReport?.unlabeled.length ?? 0) + (aclReport && sourceNeedsAclWarning(aclReport.source) ? 1 : 0);

  if (!src || !meta)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );

  return (
    <div className="settings-stack">
      <div className="tabs kb-subtabs" role="tablist" aria-label="知識庫子頁">
        {KB_SUBS.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={sub === item.key}
            className={`tab${sub === item.key ? " active" : ""}`} onClick={() => setSub(item.key)}>
            {item.label}
            {item.key === "access" && accessWarnings > 0 && <span className="assignment-count-badge" aria-label={`${accessWarnings} 項待處理`}>{accessWarnings}</span>}
          </button>
        ))}
      </div>

      <div hidden={sub !== "sources"}>
        <div className="kb-cols">
          <div className="kb-col">
            <SourceCard
              tenantId={tenantId}
              src={src}
              dirty={sourceDirty}
              meta={meta}
              job={job}
              labels={labels}
              departments={departments}
              fileMaxMb={fileMaxMb}
              onChange={(patch) => setSrc((s) => (s ? { ...s, ...patch } : s))}
              onSaved={(saved) => { setSrc(saved); setSavedSrc(saved); }}
              onJobStarted={startJob}
              onReload={reloadAll}
              onReloadAcl={loadAcl}
              onIndexCleared={() => setIndexEpoch((n) => n + 1)}
              onError={onError}
            />
          </div>
          <div className="kb-col">
            <FilesCard
              tenantId={tenantId}
              files={meta.files ?? []}
              labels={labels}
              focusFileId={focusFileId}
              onFocusHandled={() => setFocusFileId(null)}
              onReload={reloadAll}
              onError={onError}
            />
            <IndexStatusCard meta={meta} job={job} />
          </div>
        </div>
      </div>

      <div hidden={sub !== "access"}>
        {aclReport && (
          <AccessPanel
            tenantId={tenantId}
            aclReport={aclReport}
            labels={labels}
            files={meta.files ?? []}
            onEditFile={(fileId) => { setSub("sources"); setFocusFileId(fileId); }}
            onReload={reloadAll}
            onReloadAcl={loadAcl}
            onError={onError}
          />
        )}
      </div>

      <div hidden={sub !== "prompts"}>
        <PromptsPanel
          tenantId={tenantId}
          meta={meta}
          onMetaChange={(update) => setMeta((m) => (m ? update(m) : m))}
          onError={onError}
        />
      </div>

      <div hidden={sub !== "test"}>
        <TestPanel tenantId={tenantId} labels={labels} indexEpoch={indexEpoch} onError={onError} />
      </div>
    </div>
  );
}
