import { useCallback, useEffect, useState } from "react";
import { useToast } from "@hyagent/ui";
import {
  api,
  type KnowledgeAccessLog,
  type KnowledgeAccessLogQuery,
  type KnowledgeAccessLogSettings,
  type KnowledgeAccessPath,
  type KnowledgeFileMeta,
  type KnowledgeLabel,
} from "../../../api";
import { useConfirm } from "../../../components/confirm";
import { useUnsavedChanges } from "../../../components/unsaved";
import { labelNameFor } from "../knowledgeAcl.util";

const PATH_LABELS: Record<KnowledgeAccessPath, string> = {
  chat: "問答",
  table: "問答（表格）",
  report: "報告",
  admin_test: "後台試查",
};

const MIN_DAYS = 30;
const MAX_DAYS = 3650;

/** 日期欄（yyyy-mm-dd，瀏覽器本地時區）→ ISO；to 取隔天 00:00 作為不含上界 */
function dayStartIso(day: string, offsetDays = 0): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}

/**
 * 敏感文件存取紀錄：只記非公開（訪客看不到）檔案的取用，回答「誰看過這份文件」。
 * 不含問句與內容；保存天數可在此調整，立即生效。
 */
export default function AccessLogCard({ tenantId, files, labels, onError }: {
  tenantId: string;
  files: KnowledgeFileMeta[];
  labels: KnowledgeLabel[];
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [fileId, setFileId] = useState("");
  const [userId, setUserId] = useState("");
  const [path, setPath] = useState<KnowledgeAccessPath | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState<KnowledgeAccessLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<KnowledgeAccessLogSettings | null>(null);
  const [editingDays, setEditingDays] = useState<string | null>(null);
  const [savingDays, setSavingDays] = useState(false);
  useUnsavedChanges("知識庫：存取紀錄保存天數", editingDays !== null && settings !== null && editingDays !== String(settings.retentionDays));

  const query = useCallback((): KnowledgeAccessLogQuery => ({
    ...(fileId ? { fileId } : {}),
    ...(userId.trim() ? { userId: userId.trim() } : {}),
    ...(path ? { path } : {}),
    ...(from ? { from: dayStartIso(from) } : {}),
    ...(to ? { to: dayStartIso(to, 1) } : {}),
  }), [fileId, userId, path, from, to]);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const page = await api.listKnowledgeAccessLogs(tenantId, { ...query(), ...(cursor ? { cursor } : {}) });
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setSettings({ retentionDays: page.retentionDays, platformDefaultDays: page.platformDefaultDays, overridden: page.overridden });
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [tenantId, query, onError]);

  // 只在切換租戶時自動載入；篩選條件按「查詢」才套用
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [tenantId]);

  const saveDays = async (days: number | null) => {
    if (!settings) return;
    const nextDays = days ?? settings.platformDefaultDays;
    if (days !== null && (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS)) {
      toast.error(`保存天數須為 ${MIN_DAYS}–${MAX_DAYS} 的整數`);
      return;
    }
    if (nextDays < settings.retentionDays) {
      const ok = await confirm({
        title: `縮短保存天數為 ${nextDays} 天？`,
        message: `超過 ${nextDays} 天的存取紀錄會在下一次每日清除時永久刪除，無法復原。`,
        confirmText: "縮短",
      });
      if (!ok) return;
    }
    setSavingDays(true);
    try {
      setSettings(await api.updateKnowledgeAccessLogSettings(tenantId, days));
      setEditingDays(null);
      toast.success("已更新保存天數");
    } catch (e) {
      onError(e);
    } finally {
      setSavingDays(false);
    }
  };

  // 會被記錄的網站取用必定是「限定部門」（公開網站不記），不能沿用「所有人可查詢」的通用名稱
  const scopeName = (scope: string) => (scope === "kb:__website_access" ? "網站：限定部門" : labelNameFor(labels, scope));

  const fileName = (log: KnowledgeAccessLog) => {
    if (!log.fileId) return `網站：${log.fileName}`;
    return files.some((f) => f.fileId === log.fileId) ? log.fileName : `${log.fileName}（已刪除）`;
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">存取紀錄</div>
          <div className="card-desc">
            記錄誰在問答、報告或後台試查中取用了非公開（訪客看不到）的文件。不記問句與文件內容。
          </div>
        </div>
      </div>
      <div className="card-body">
        {settings && (editingDays === null ? (
          <p className="row-sub">
            保存 {settings.retentionDays} 天{settings.overridden ? "（此租戶單獨設定）" : "（平台預設）"}，每日清除過期紀錄。{" "}
            <button type="button" className="btn btn-sm" onClick={() => setEditingDays(String(settings.retentionDays))}>調整</button>
          </p>
        ) : (
          <div className="form-actions" style={{ alignItems: "center" }}>
            <label className="field-label" htmlFor="kb-access-log-days">保存天數</label>
            <input id="kb-access-log-days" className="input" style={{ maxWidth: 120 }} type="number" min={MIN_DAYS} max={MAX_DAYS}
              value={editingDays} disabled={savingDays} onChange={(e) => setEditingDays(e.target.value)} />
            <button type="button" className="btn btn-primary btn-sm" disabled={savingDays} onClick={() => void saveDays(Number(editingDays))}>儲存</button>
            {settings.overridden && <button type="button" className="btn btn-sm" disabled={savingDays}
              onClick={() => void saveDays(null)}>恢復平台預設（{settings.platformDefaultDays} 天）</button>}
            <button type="button" className="btn btn-sm" disabled={savingDays} onClick={() => setEditingDays(null)}>取消</button>
          </div>
        ))}
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="kb-access-log-file">文件</label>
            <select id="kb-access-log-file" className="select" value={fileId} onChange={(e) => setFileId(e.target.value)}>
              <option value="">全部文件</option>
              {files.map((f) => <option key={f.fileId} value={f.fileId}>{f.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="kb-access-log-user">使用者</label>
            <input id="kb-access-log-user" className="input" value={userId} placeholder="帳號，例：HYW001"
              onChange={(e) => setUserId(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="kb-access-log-path">來源</label>
            <select id="kb-access-log-path" className="select" value={path} onChange={(e) => setPath(e.target.value as KnowledgeAccessPath | "")}>
              <option value="">全部來源</option>
              {(Object.keys(PATH_LABELS) as KnowledgeAccessPath[]).map((p) => <option key={p} value={p}>{PATH_LABELS[p]}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="kb-access-log-from">起日</label>
            <input id="kb-access-log-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="kb-access-log-to">迄日</label>
            <input id="kb-access-log-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={loading} onClick={() => void load()}>
            {loading ? "查詢中…" : "查詢"}
          </button>
        </div>
      </div>
      <ul className="list" aria-label="存取紀錄">
        {items.map((log) => (
          <li key={log.id} className="row">
            <div className="row-main">
              <div className="row-title">{fileName(log)}</div>
              <div className="row-sub">
                {new Date(log.at).toLocaleString("zh-TW")} · {log.userId || "網站訪客"} · {PATH_LABELS[log.path] ?? log.path}
                {log.actorId ? `（由 ${log.actorId} 以此身分試查）` : ""}
                {log.scopes.length > 0 ? ` · 標籤：${log.scopes.map(scopeName).join("、")}` : ""}
              </div>
            </div>
          </li>
        ))}
        {!loading && items.length === 0 && <li className="empty">沒有符合條件的存取紀錄。</li>}
      </ul>
      {nextCursor && (
        <div className="card-body">
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void load(nextCursor)}>載入更多</button>
        </div>
      )}
    </div>
  );
}
