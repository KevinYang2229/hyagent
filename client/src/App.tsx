import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge, Button, Input, type StatusBadgeVariant } from '@oa-agent/ui';
import {
  api,
  ApiError,
  auth,
  setUnauthorizedHandler,
  type Applicant,
  type Definition,
  type FormSummary,
  type LeaveBalance,
  type SessionStatus,
  type SubmissionInfo,
  type TurnData,
} from './api';
import type { TenantAppearance } from '@oa-agent/shared';
import { changeLanguage } from './i18n';
import { embedConfig, fetchAppearance } from './embedConfig';
import FormView from './FormView';
import LoginView from './LoginView';
import SettingsMenu, { FONT_MAX, FONT_MIN } from './SettingsMenu';

type Role = 'user' | 'agent' | 'sys';
interface ChatMessage {
  id: number;
  role: Role;
  text: string;
  /** 訊息送出時間（epoch ms），用來在氣泡下方顯示日期時間 */
  at: number;
  /** Agent 訊息附帶的建議回覆；僅最新一則會在 UI 顯示為快捷按鈕 */
  suggestions?: string[];
  /** 開場問候訊息：文字隨 AI 名稱即時重算（不存死字串），讓改名後／預覽即時反映 */
  greeting?: boolean;
}

// 氣泡下方時間：YYYY-MM-DD HH:mm:ss
function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

type Theme = 'light' | 'dark';
// AI 連線狀態：checking 連線中 / online 已連線（AI 可正常呼叫）/ offline 未連線
type Conn = 'checking' | 'online' | 'offline';

// session 狀態 → 設計系統 Badge 的 status 變體
const STATUS_BADGE: Record<SessionStatus, StatusBadgeVariant> = {
  collecting: 'info',
  confirming: 'warning',
  submitting: 'process',
  submitted: 'success',
  cancelled: 'default',
  failed: 'danger',
};

let seq = 0;
const nextId = () => ++seq;

// 套用租戶主色到設計系統 CSS 變數：同時寫 --primary-color（hex）與 --primary-color-rgb（r, g, b），
// 後者供 rgba(var(--primary-color-rgb), a) 形式的陰影/底色使用，確保整體配色一致。傳空值則清除覆寫。
function applyPrimaryColor(hex?: string): void {
  const root = document.documentElement.style;
  if (!hex || !hex.trim()) {
    root.removeProperty('--primary-color');
    root.removeProperty('--primary-color-rgb');
    return;
  }
  root.setProperty('--primary-color', hex);
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (m) {
    root.setProperty('--primary-color-rgb', `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}`);
  }
}

// 嵌入模式：以 ?embed=1 載入（widget iframe 用），隱藏整頁頁首讓畫面像純聊天 widget。
const EMBED = embedConfig.embed;
// 純外觀預覽：後台 AppearanceTab 以 ?preview=1 載入 iframe，跳過登入、只渲染面板外殼且不打後端。
const PREVIEW = embedConfig.preview;

// 逐字浮現：Agent 回覆抵達後一字一字顯示，營造「正在回覆」的動態感。
// 元件以 message id 為 key，狀態隨實例保留 → 既有訊息不會在重繪（如切主題）時重播。
function TypewriterText({ text, onTick }: { text: string; onTick?: () => void }) {
  const [count, setCount] = useState(0);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    // 尊重使用者「減少動態」偏好：直接整段顯示
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !text) {
      setCount(text.length);
      return;
    }
    setCount(0);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setCount(i);
      onTickRef.current?.();
      if (i >= text.length) clearInterval(timer);
    }, 18);
    return () => clearInterval(timer);
  }, [text]);

  const done = count >= text.length;
  return (
    <div className="md-body">
      {/* 逐字浮現：對已揭露的片段做 markdown 渲染（未閉合語法會短暫以原文呈現，屬正常） */}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text.slice(0, count)}</ReactMarkdown>
      {!done && <span className="type-caret" aria-hidden />}
    </div>
  );
}

export default function App() {
  const { t, i18n } = useTranslation();

  // 登入者；未登入為 null。userId 由登入者帶出（不再手動輸入）
  const [authUser, setAuthUser] = useState<Applicant | null>(null);
  const [authReady, setAuthReady] = useState(false); // 重整時還原登入狀態的載入旗標
  const userId = authUser?.id ?? '';
  const [convId, setConvId] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submission, setSubmission] = useState<SubmissionInfo | null>(null);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  // 租戶自訂 AI 名稱；優先序：data-*（embedConfig.name / 後台預覽即時帶入）> 後端外觀。空字串則 fallback 回 i18n 預設
  const [assistantName, setAssistantName] = useState(embedConfig.assistantName ?? '');
  // 租戶外觀：自訂 logo（標題列顯示）與歡迎語（覆蓋預設開場白）
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<string | null>(null);
  // 目前顯示用 AI 名稱與開場問候（隨設定即時變動）：租戶歡迎語優先，否則用帶入 AI 名稱的預設問候
  const aiName = assistantName || t('app.aiName');
  const greetingText = welcome ?? t('app.greeting', { name: aiName });
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: nextId(), role: 'agent', text: greetingText, greeting: true, at: Date.now() },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<Conn>('checking');
  const [formDef, setFormDef] = useState<Definition | null>(null);
  const [showForm, setShowForm] = useState(false);
  // 可辦理的表單清單與目前選取的類型（新對話開始時帶給 server；未選則由 server 意圖路由）
  const [forms, setForms] = useState<FormSummary[]>([]);
  // 嵌入時可由 data-form 預選表單類型（widget → URL ?form=）
  const [selectedFormId, setSelectedFormId] = useState<string | null>(embedConfig.formId);
  // 側欄（已填欄位／送出結果）收合：桌機向右收、手機向上收（CSS 依斷點處理方向）
  const [paneOpen, setPaneOpen] = useState(false); // 表單明細預設收合
  const [pickerOpen, setPickerOpen] = useState(true); // 「要辦理什麼？」可收合，預設展開
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(true); // 知識庫服務是否啟用（依租戶）
  // 主題優先序：data-theme（宿主明確）> 嵌入時略過本地記憶（避免與第一方 App 共用 localStorage 互相干擾，
  // 改由租戶 theme/預設決定）> 第一方 App 才讀本地記憶 > 預設淺色。後端 theme 於下方 effect 補上。
  const [theme, setTheme] = useState<Theme>(
    () => embedConfig.theme ?? (EMBED ? 'light' : ((localStorage.getItem('oa-theme') as Theme) || 'light')),
  );
  // 系統字級（百分比）：縮放整個介面的 root font-size
  const [fontScale, setFontScale] = useState<number>(() => {
    const saved = Number(localStorage.getItem('oa-font-scale'));
    return saved >= FONT_MIN && saved <= FONT_MAX ? saved : 100;
  });

  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 主題：寫到 <html data-theme>，設計系統 token 隨之切換。
  // 不在此記憶 localStorage——否則掛載即寫入會讓「後端/租戶 theme 只在無本地記憶時套用」永遠失效。
  // 只有使用者由設定選單主動切換時才記憶（見 handleThemeChange）。
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // 使用者主動切換主題：更新狀態並記憶（第一方 App 才有設定選單；嵌入模式無此 UI）
  function handleThemeChange(next: Theme) {
    setTheme(next);
    localStorage.setItem('oa-theme', next);
  }

  // 系統字級：調整 root font-size（rem 為基準，整個介面隨之縮放）並記憶
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontScale}%`;
    localStorage.setItem('oa-font-scale', String(fontScale));
  }, [fontScale]);

  // 後端外觀：依租戶（apiKey）讀 /widget/config 套用全部欄位。
  // 共通原則：使用者／宿主的明確選擇（URL data-* 或本地記憶）優先，租戶設定只作後備預設。
  useEffect(() => {
    let cancelled = false;
    void fetchAppearance().then(({ appearance: a, knowledgeEnabled: ke }) => {
      if (cancelled) return;
      setKnowledgeEnabled(ke);
      // 主色：寫 --primary-color / --primary-color-rgb（applyPrimaryColor 處理 hex→rgb）
      if (a.primaryColor) applyPrimaryColor(a.primaryColor);
      // AI 名稱：後端名稱僅在沒有 data-* 覆寫（後台預覽）時採用，不蓋掉宿主明確指定
      if (a.assistantName?.trim() && !embedConfig.assistantName) setAssistantName(a.assistantName.trim());
      // 主題：宿主未用 data-theme 覆寫時採用租戶 theme。嵌入模式忽略本地記憶（由租戶決定）；
      // 第一方 App 才尊重使用者的本地記憶選擇。
      if (a.theme && !embedConfig.theme && (EMBED || !localStorage.getItem('oa-theme'))) {
        setTheme(a.theme);
      }
      // 預設語言：同理。以 persist=false 套用，不寫本地記憶（保持「租戶預設 vs 使用者選擇」可區分）。
      if (a.defaultLocale && !embedConfig.locale && (EMBED || !localStorage.getItem('oa-lang'))) {
        changeLanguage(a.defaultLocale, false);
      }
      // 自訂 logo：顯示於標題列
      if (a.logoUrl) setLogoUrl(a.logoUrl);
      // 歡迎語：覆蓋開場白（透過 greetingText 機制即時套用到所有 greeting 訊息）
      if (a.welcomeMessage?.trim()) setWelcome(a.welcomeMessage.trim());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 後台外觀預覽：父視窗（admin）以 postMessage 即時推送外觀，免重載 iframe（避免每次編輯閃爍/延遲）。
  // 載入後先向父視窗握手要目前設定，之後父視窗每次變更都會推來；非 iframe 載入時不啟用。
  useEffect(() => {
    if (window.parent === window) return;
    function onMessage(e: MessageEvent) {
      const data = e.data as { source?: string; appearance?: TenantAppearance } | null;
      if (data?.source !== 'oa-admin-preview' || !data.appearance) return;
      const a = data.appearance;
      applyPrimaryColor(a.primaryColor);
      if (a.theme) setTheme(a.theme);
      if (a.defaultLocale) changeLanguage(a.defaultLocale, false);
      setAssistantName(a.assistantName?.trim() ?? '');
      setLogoUrl(a.logoUrl?.trim() || null);
      setWelcome(a.welcomeMessage?.trim() || null);
    }
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ source: 'oa-widget-ready' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 啟動：還原登入狀態（有 token 就用 /me 取使用者）；並註冊 401（refresh 失敗）→ 登出
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthUser(null);
      resetSessionState();
    });
    // 嵌入時若帶 data-locale，套用介面語言
    if (embedConfig.locale) changeLanguage(embedConfig.locale, false);
    // 純外觀預覽：不做任何登入/後端請求，直接以合成使用者渲染面板外殼（外觀由父視窗 postMessage 推入）。
    if (PREVIEW) {
      setAuthUser({
        id: 'preview',
        name: t('app.previewUserName', { defaultValue: 'Preview' }),
        department: '',
      });
      setAuthReady(true);
      return;
    }
    void (async () => {
      try {
        // 嵌入 SSO handoff：帶 userToken 且尚未登入 → 以宿主 token 換發本系統 token（免帳密登入）
        if (embedConfig.userToken && !auth.isAuthenticated()) {
          await auth.ssoExchange(embedConfig.userToken);
        }
        if (auth.isAuthenticated()) {
          setAuthUser(await auth.me());
        }
      } catch {
        setAuthUser(null);
      } finally {
        setAuthReady(true);
      }
    })();
     
  }, []);

  const scrollToEnd = useCallback(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [messages, busy, scrollToEnd]);

  // AI 連線狀態：登入後探測 /healthz（server 起得來＝LLM key 已通過驗證），並每 30s 重探一次
  useEffect(() => {
    if (!authUser || PREVIEW) return;
    let alive = true;
    const ping = async () => {
      const ok = await api.health();
      if (alive) setConn(ok ? 'online' : 'offline');
    };
    void ping();
    const timer = setInterval(ping, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [authUser]);

  // 可辦理的表單清單：登入後載入，供表單類型選單；預設選第一個（請假）
  useEffect(() => {
    if (!authUser || PREVIEW) return;
    let alive = true;
    api
      .listForms()
      .then((list) => {
        if (!alive) return;
        setForms(list);
        // 不預選：使用者先選辦理項目，才顯示該表單的動態提示按鈕
      })
      .catch(() => alive && setForms([]));
    return () => {
      alive = false;
    };
  }, [authUser]);

  // 假別剩餘時數：登入後依使用者載入，供表單顯示「今年度剩餘 N 小時」
  useEffect(() => {
    if (!authUser || PREVIEW) return;
    let alive = true;
    api
      .getLeaveBalances(authUser.id)
      .then((b) => alive && setBalances(b))
      .catch(() => alive && setBalances([]));
    return () => {
      alive = false;
    };
  }, [authUser]);

  function pushMsg(role: Role, text: string, suggestions?: string[]) {
    setMessages((prev) => [...prev, { id: nextId(), role, text, suggestions, at: Date.now() }]);
  }

  // 對話已不存在（多半是後端重啟導致記憶體 session 遺失）。404 → 視為連線重置
  const isSessionGone = (e: unknown) => e instanceof ApiError && e.status === 404;

  // 優雅地清掉本地對話狀態，下一則訊息會自動開新對話
  function resetSessionState() {
    setConvId(null);
    setStatus(null);
    setValues({});
    setSubmission(null);
    setShowForm(false);
    setFormDef(null);
  }

  function handleLogin(user: Applicant) {
    setAuthUser(user);
    setMessages([{ id: nextId(), role: 'agent', text: greetingText, greeting: true, at: Date.now() }]);
  }

  function handleLogout() {
    auth.logout();
    setAuthUser(null);
    setBalances([]);
    resetSessionState();
  }

  function applyTurn(data: TurnData, sessionId: string | null) {
    if (data.id) setConvId(data.id);
    // status 為上一輪的值（setState 尚未生效），用來判斷是否「剛進入」表單階段
    const prevStatus = status;
    setStatus(data.status);
    setValues(data.values ?? {});
    setSubmission(data.submission ?? null);
    if (data.reply) pushMsg('agent', data.reply, data.suggestions);

    // 只在「剛填寫完畢（→confirming）」或「剛送出（→submitted）」的轉變當下主動開表單；
    // 停留在同一狀態（例如 confirming 中繼續問話）不再強制彈出。
    const enteredFormStage =
      (data.status === 'confirming' || data.status === 'submitted') && data.status !== prevStatus;
    if (enteredFormStage) {
      void loadAndShowForm(data.id ?? sessionId);
    }
    // 剛送出（→submitted）：一個 session 只處理一張表單，提醒使用者要申請其他表單需重新開始
    if (data.status === 'submitted' && prevStatus !== 'submitted') {
      pushMsg('sys', t('app.submittedHint'));
      // 通知宿主頁：表單已送出（widget.js 轉成 DOM 事件 / callback 供整合方接手，如關閉彈窗或導頁）
      if (EMBED) {
        window.parent.postMessage(
          { type: 'oa-agent:submitted', submission: data.submission ?? null },
          '*',
        );
      }
    }
  }

  async function loadAndShowForm(sessionId: string | null) {
    if (!sessionId) return;
    try {
      let def = formDef;
      if (!def) {
        const conv = await api.getConversation(userId, sessionId);
        def = await api.getForm(conv.formId);
        setFormDef(def);
      }
      setShowForm(true);
    } catch (e) {
      pushMsg('sys', '⚠️ ' + t('app.loadFormFailed') + (e instanceof Error ? e.message : ''));
    }
  }

  async function send(message: string) {
    if (busy) return;
    // 純外觀預覽：不連後端，回一則本地示範回覆即可（避免 401 被踢回登入）。
    if (PREVIEW) {
      pushMsg('agent', greetingText);
      return;
    }
    setBusy(true);
    try {
      // 一個 session 一張表單：上一張已送出／取消後，下一則訊息自動開新對話（而非送進已結束的 session）
      const terminal = status === 'submitted' || status === 'cancelled';
      if (terminal) resetSessionState();
      const data =
        convId && !terminal
          ? await api.sendMessage(userId, convId, message)
          : await api.start(userId, message, selectedFormId ?? undefined);
      applyTurn(data, terminal ? null : convId);
      setConn('online'); // 成功通一輪＝確定連線正常
    } catch (e) {
      if (isSessionGone(e)) {
        resetSessionState();
        pushMsg('sys', t('app.sessionExpired'));
      } else {
        // 非 API 錯誤（多為網路不可達）才視為離線；API 回傳的業務錯誤仍代表連線正常
        if (!(e instanceof ApiError)) setConn('offline');
        pushMsg('sys', '⚠️ ' + (e instanceof Error ? e.message : t('app.requestFailed')));
      }
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  }

  // 確認畫面送出：先把編輯後的草稿（差異）存回後端，再送「確認」觸發 submit
  async function handleConfirm(draft: Record<string, unknown>) {
    if (!convId || busy) return;
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      // 物件／陣列欄位（如附件）以 JSON 比較，避免 String() 把不同內容都變成 [object Object]
      const isComplex = typeof v === 'object' && v !== null;
      const differs = isComplex
        ? JSON.stringify(v) !== JSON.stringify(values[k] ?? null)
        : String(v ?? '') !== String(values[k] ?? '');
      if (differs) changed[k] = v;
    }

    setBusy(true);
    try {
      if (Object.keys(changed).length > 0) {
        const upd = await api.updateFields(userId, convId, changed);
        setStatus(upd.status);
        setValues(upd.values);
        if (upd.rejected.length > 0) {
          throw new Error(upd.rejected.map((r) => r.message).join('；'));
        }
        if (upd.status !== 'confirming') {
          throw new Error(t('form.incomplete'));
        }
      }
      pushMsg('user', t('app.confirm'));
      // 直接走確定送出端點（不經 LLM），確保按一次即送出
      const turn = await api.submit(userId, convId);
      applyTurn(turn, convId);
      if (turn.submission) {
        pushMsg('agent', t('app.submittedMsg', { id: turn.submission.oaRequestId }));
      }
    } finally {
      setBusy(false);
    }
  }

  // 取消：打後端 cancel 端點（非送對話訊息，Agent 無取消工具）
  async function handleCancel() {
    if (!convId || busy) return;
    setBusy(true);
    try {
      const res = await api.cancel(userId, convId);
      setStatus(res.status);
      setShowForm(false);
      pushMsg('sys', t('app.cancelledMsg'));
    } catch (e) {
      // 對話已不存在＝本來就沒得取消，視同已結束、清掉本地狀態即可
      if (isSessionGone(e)) {
        resetSessionState();
        pushMsg('sys', t('app.sessionExpired'));
      } else {
        pushMsg('sys', '⚠️ ' + t('app.cancelFailed') + (e instanceof Error ? e.message : ''));
      }
    } finally {
      setBusy(false);
    }
  }

  function submitForm() {
    const text = input.trim();
    if (!text || busy) return;
    pushMsg('user', text);
    setInput('');
    void send(text);
  }

  /** 點聊天歡迎區的範例提示：直接送出，幫使用者快速開始 */
  function sendQuick(text: string) {
    if (busy) return;
    pushMsg('user', text);
    setInput('');
    void send(text);
  }
  // 開場引導用的範例提示：取目前選取表單的範例語句（純動態，依辦理項目而定）；對話開始後就不再顯示
  const selectedForm = forms.find((f) => f.formId === selectedFormId);
  // 範例提示：內建表單依語系取 i18n（forms.<id>.examples），查不到（自訂表單）回退 server 範例
  const quickPrompts = selectedForm
    ? (t(`forms.${selectedForm.formId}.examples`, {
        returnObjects: true,
        defaultValue: selectedForm.examples ?? [],
      }) as string[])
    : [];
  // 知識庫推薦用詞：僅在知識庫服務啟用時顯示（i18n 陣列）
  const kbPromptsRaw = t('app.knowledgePrompts', { returnObjects: true });
  const knowledgePrompts = knowledgeEnabled && Array.isArray(kbPromptsRaw) ? (kbPromptsRaw as string[]) : [];

  // 建議回覆：只取「最新一則 agent 訊息」附帶的建議，作為可一鍵送出的快捷按鈕
  const lastMsg = messages[messages.length - 1];
  const replySuggestions = lastMsg?.role === 'agent' ? (lastMsg.suggestions ?? []) : [];

  function reset() {
    setConvId(null);
    setStatus(null);
    setValues({});
    setSubmission(null);
    setShowForm(false);
    setMessages([
      { id: nextId(), role: 'agent', text: greetingText, greeting: true, at: Date.now() },
      { id: nextId(), role: 'sys', text: t('app.restarted'), at: Date.now() },
    ]);
    taRef.current?.focus();
  }

  // 嵌入模式：通知外層 widget.js 收起彈窗（widget.js 監聽此 message）。未被嵌入時 parent===self，無副作用。
  function closeWidget() {
    window.parent.postMessage({ type: 'oa-agent:close' }, '*');
  }

  const valueEntries = Object.entries(values).filter(
    ([, v]) =>
      v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
  );

  // 側欄顯示字串：陣列（如附件）顯示「N 個項目」，其餘照原值
  const formatPaneValue = (v: unknown): string =>
    Array.isArray(v) ? t('app.itemsCount', { count: v.length }) : String(v);

  // 還原登入狀態中：先不渲染，避免閃一下登入頁
  if (!authReady) return null;
  // 未登入：擋住整個 App，只顯示登入頁
  if (!authUser) return <LoginView onLogin={handleLogin} assistantName={aiName} />;

  return (
    <div className={`app-shell${EMBED ? ' app-shell-embed' : ''}`}>
      {!EMBED && (
      <header className="app-header">
        {/* 品牌：AI 小幫手 + 連線狀態圓點（綠＝已連線，AI 可正常呼叫） */}
        <div className="app-brand">
          {logoUrl && <img src={logoUrl} alt="" className="app-logo" />}
          <h1 className="app-title">{aiName}</h1>
          <span
            className={`conn conn-${conn}`}
            role="status"
            aria-live="polite"
            title={t(`app.conn.${conn}`)}
          >
            <span className="conn-dot" aria-hidden="true" />
            {t(`app.conn.${conn}`)}
          </span>
        </div>

        {/* 其餘控制項整組靠右；空間夠 inline，不夠自動換行 */}
        <div className="app-collapse">
          <div className="app-meta">
            <span className="app-meta-item">
              <span className="app-meta-label">{t('app.user')}</span>
              <span className="app-meta-value">{authUser.name}</span>
            </span>

            <span className="app-meta-sep" aria-hidden="true" />

            <span className="app-meta-item">
              <Badge status={status ? STATUS_BADGE[status] : 'normal'}>
                {status ? t(`app.status.${status}`) : t('app.statusInitial')}
              </Badge>
            </span>

            <span className="app-meta-sep" aria-hidden="true" />

            <button type="button" className="app-reset" onClick={reset}>
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {t('app.reset')}
            </button>
          </div>

          {/* 齒輪設定：外觀模式 / 系統字級 / 切換語言 / 登出 */}
          <SettingsMenu
            theme={theme}
            onThemeChange={handleThemeChange}
            language={i18n.language}
            onLanguageChange={changeLanguage}
            fontScale={fontScale}
            onFontScaleChange={setFontScale}
            onLogout={handleLogout}
          />
        </div>
      </header>
      )}

      {/* 嵌入模式專用的精簡標題列：標題 + 重新開始 + 關閉（取代整頁 chrome） */}
      {EMBED && (
        <header className="embed-header">
          <div className="embed-brand">
            {logoUrl && <img src={logoUrl} alt="" className="embed-logo" />}
            <span className="embed-title">{aiName}</span>
          </div>
          <div className="embed-actions">
            <button
              type="button"
              className="embed-btn"
              onClick={reset}
              title={t('app.reset')}
              aria-label={t('app.reset')}
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button
              type="button"
              className="embed-btn"
              onClick={closeWidget}
              title={t('app.close')}
              aria-label={t('app.close')}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>
      )}

      <div className="app-body">
        <div className="chat-pane">
          <div className="msg-list" ref={listRef}>
            {messages.map((m) =>
              m.role === 'sys' ? (
                <div key={m.id} className="bubble bubble-sys">
                  {m.text}
                </div>
              ) : (
                <div key={m.id} className={`msg msg-${m.role}`}>
                  {/* 對象名稱：AI 視窗顯示 AI 名稱，使用者訊息顯示登入者名稱 */}
                  <span className="msg-name">
                    {m.role === 'agent' ? aiName : authUser.name}
                  </span>
                  <div className={`bubble bubble-${m.role}`}>
                    {m.role === 'agent' ? (
                      <TypewriterText text={m.greeting ? greetingText : m.text} onTick={scrollToEnd} />
                    ) : (
                      m.text
                    )}
                  </div>
                  {/* 送出日期時間 */}
                  <span className="msg-time">{formatTime(m.at)}</span>
                </div>
              ),
            )}
            {busy && (
              <div className="bubble-typing" aria-label={t('app.typing')}>
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            )}
          </div>

          {/* 辦理項目選單：表單（選擇）+ 知識庫推薦用詞（直接詢問）；對話開始前顯示 */}
          {!convId && !busy && (forms.length > 1 || knowledgePrompts.length > 0) && (
            <div className="form-picker">
              <div className="form-picker-hint flex w-full items-center justify-between">
                <span>{t('app.formPickerHint')}</span>
                <button
                  type="button"
                  onClick={() => setPickerOpen((o) => !o)}
                  aria-expanded={pickerOpen}
                  aria-label={t('app.formPickerHint')}
                  className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--text-secondary) transition-colors hover:bg-(--nav-hover) hover:text-(--text-primary)"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                    style={{
                      transform: pickerOpen ? 'rotate(-90deg)' : 'rotate(90deg)',
                      transition: 'transform 0.2s ease',
                      transformOrigin: 'center',
                    }}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
              {pickerOpen && (
                <>
                  {forms.length > 1 &&
                    forms.map((f) => (
                      <button
                        key={f.formId}
                        type="button"
                        className={`quick-chip${selectedFormId === f.formId ? ' active' : ''}`}
                        onClick={() => setSelectedFormId(f.formId)}
                        title={t(`forms.${f.formId}.description`, { defaultValue: f.description })}
                        aria-pressed={selectedFormId === f.formId}
                      >
                        {t(`forms.${f.formId}.title`, { defaultValue: f.title })}
                      </button>
                    ))}
                  {/* 知識庫推薦用詞：只顯示一個，樣式與表單 chip 一致；點擊直接以該問句發問 */}
                  {knowledgePrompts.slice(0, 1).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="quick-chip"
                      onClick={() => sendQuick(p)}
                      title={p}
                    >
                      {p}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}

          {/* 開場引導：需先選定辦理項目，才顯示該表單的動態範例提示 */}
          {!convId && !busy && selectedFormId && quickPrompts.length > 0 && (
            <div className="quick-bar">
              <span className="quick-hint">{t('app.quickHint')}</span>
              {quickPrompts.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="quick-chip"
                  onClick={() => sendQuick(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* 建議回覆：AI 回覆下方的一鍵快捷按鈕（點擊即送出） */}
          {!busy && replySuggestions.length > 0 && (
            <div className="suggest-bar">
              {replySuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="quick-chip"
                  onClick={() => sendQuick(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              submitForm();
            }}
          >
            <span className="min-w-0 flex-1">
              <Input
                autoFocus
                placeholder={t('app.inputPlaceholder')}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // 輸入法組字中的 Enter 是「選字」，不可當送出（否則中文會殘留在框內）
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submitForm();
                  }
                }}
              />
            </span>
            <Button variant="confirm" size="md" type="submit" disabled={busy}>
              {t('app.send')}
            </Button>
          </form>
        </div>

        {/* 無表單服務（forms 為空）時不顯示「表單明細」側欄 */}
        {forms.length > 0 && (
        <aside className={`side-pane${paneOpen ? '' : ' collapsed'}`}>
          <button
            type="button"
            className="side-toggle"
            onClick={() => setPaneOpen((o) => !o)}
            aria-expanded={paneOpen}
            aria-label={t(paneOpen ? 'app.collapsePane' : 'app.expandPane')}
            title={t(paneOpen ? 'app.collapsePane' : 'app.expandPane')}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* 收合時在細條上顯示的標籤（桌機直書、手機橫書），避免看起來空白單調 */}
          <span className="side-collapsed-label">{t('app.paneLabel')}</span>

          <div className="side-content">
            <h2 className="side-title">{t('app.filledFields')}</h2>
          {valueEntries.length ? (
            valueEntries.map(([k, v]) => (
              <div className="kv-row" key={k}>
                <span className="kv-key">{k}</span>
                <span className="kv-val">{formatPaneValue(v)}</span>
              </div>
            ))
          ) : (
            <div className="empty-hint">{t('app.noData')}</div>
          )}

          <h2 className="side-title mt-5">{t('app.result')}</h2>
          {submission ? (
            <>
              <div className="kv-row">
                <span className="kv-key">{t('app.oaNo')}</span>
                <span className="kv-val">{submission.oaRequestId}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">{t('app.statusField')}</span>
                <span className="kv-val">{submission.status}</span>
              </div>
              <Button
                variant="reset"
                size="sm"
                type="button"
                className="mt-3 w-full"
                onClick={() => setShowForm(true)}
              >
                {t('app.viewForm')}
              </Button>
            </>
          ) : (
            <div className="empty-hint">{t('app.notSubmitted')}</div>
          )}
          </div>
        </aside>
        )}
      </div>

      {showForm && formDef && (
        <FormView
          def={formDef}
          values={values}
          balances={balances}
          submission={submission}
          busy={busy}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          onClose={() => setShowForm(false)}
          onUploadAttachment={
            convId ? (file) => api.uploadAttachment(userId, convId, file) : undefined
          }
          onDeleteAttachment={
            convId ? (id) => api.deleteAttachment(userId, convId, id).then(() => undefined) : undefined
          }
        />
      )}
    </div>
  );
}
