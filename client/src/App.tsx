import type { TaskNotification, TaskCenterData } from '@hyagent/shared';
import NotificationCenter from './NotificationCenter';
import { useNotifications } from './useNotifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge, Button, Input, type StatusBadgeVariant } from '@hyagent/ui';
import {
  api,
  ApiError,
  auth,
  setIdentityProvider,
  setUnauthorizedHandler,
  type Applicant,
  type Definition,
  type FormSummary,
  type LeaveBalance,
  type SessionStatus,
  type SubmissionInfo,
  type TurnData,
} from './api';
import type { TenantAppearance } from '@hyagent/shared';
import { changeLanguage } from './i18n';
import { debugLog } from './debugLog';
import { embedConfig, fetchAppearance } from './embedConfig';
import { hostBridge, type UiStatePayload } from './hostBridge';
import { pickKnowledgePrompts, resolveKnowledgeFeed, type KnowledgeFeed, type SuggestedPrompts } from './knowledgePrompt';
import { pickInitialFormId, shouldShowFormPicker } from './formPicker';
import FormView from './FormView';
import TaskCenter from './TaskCenter';
import MySkills from './MySkills';
import LoginView from './LoginView';
import AuthErrorView from './AuthErrorView';
import SettingsMenu, { FONT_MAX, FONT_MIN } from './SettingsMenu';
import { ReportStatus } from './ReportStatus';

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
  /**
   * 本回合啟動的報告 id（僅報告服務會帶）。掛在訊息上而非 App 層單一狀態：
   * 一段對話可能產生多份報告，各自的進度與下載入口要跟著它所屬的那則回覆走。
   */
  reportId?: string;
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
  // 登入／連線失敗訊息（SSO 換發失敗、或登入後因金鑰(pk)不正確被踢出）。
  // 有值時顯示整頁錯誤畫面，取代「靜默掉回帳密登入頁」。
  const [authError, setAuthError] = useState<string | null>(null);
  /**
   * 身分流程的世代編號（規格 §6.3）。
   *
   * 每次登出或宿主頁要求換人就 +1。取票與換發跨越好幾個 await（§6.5 的退避重試最壞逼近
   * 一分鐘），中途被登出蓋過時，恢復執行的那段不能再把換到的 Session 寫回來——否則
   * 「按了登出」會被一則還在路上的換發覆蓋，使用者看到的是登出沒有生效。
   */
  const identityEpochRef = useRef(0);
  const userId = authUser?.id ?? '';
  const [view, setView] = useState<'chat' | 'tasks' | 'notifications'>('chat');
  const notifications = useNotifications(PREVIEW ? '' : userId);
  const [taskTarget, setTaskTarget] = useState<{ category: keyof TaskCenterData; id: string } | undefined>();
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
  // 嵌入模式的放大狀態：真正撐大面板的是外層 widget.js，這裡只記狀態決定按鈕圖示／文案。
  // canExpand 也由 widget.js 告知——手機（面板已全螢幕）沒得放大，就不顯示這顆鈕。
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(true);
  const [suggestedPrompts, setSuggestedPrompts] = useState<SuggestedPrompts[] | undefined>();
  // 登入者視角的知識庫開場資料：免登入的 /widget/config 只能用訪客部門判斷開關，
  // 指派給一般部門的授權它看不到。登入後改以本人權限判定的結果覆蓋（null＝未登入／尚未取得）
  const [memberFeed, setMemberFeed] = useState<KnowledgeFeed | null>(null);
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
    void fetchAppearance().then(({ appearance: a, knowledgeEnabled: ke, suggestedPrompts: sp }) => {
      if (cancelled) return;
      setKnowledgeEnabled(ke);
      setSuggestedPrompts(sp);
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

  /**
   * 嵌入 SSO handoff（規格 §6.5、§6.6）：向宿主頁要一張 Assertion，換發本系統的 Session。
   *
   * 首次載入與宿主頁呼叫 `OAAgent.refreshIdentity()` 走的是同一段，差別只在呼叫端怎麼收尾。
   * 改造前這張票是從 iframe URL 的 ?userToken= 讀的，違反規格 §10.1；現在改由 postMessage
   * 握手取得，憑證只存在記憶體裡，不留在歷史紀錄、Referer 或存取日誌。
   *
   * 回傳換到的使用者；拿不到票（未登入宿主網站／取票失敗／逾時）、換發失敗、或流程中途
   * 被登出蓋過，一律回 null。
   */
  async function runSsoHandoff(): Promise<Applicant | null> {
    const epoch = identityEpochRef.current;
    if (embedConfig.identityAvailable && !auth.isAuthenticated()) {
      // 拿不到票（使用者未登入宿主網站／取票失敗／逾時）一律當作匿名，落回自行登入頁。
      const assertion = await hostBridge.requestIdentity();
      if (identityEpochRef.current !== epoch) return null;
      if (assertion) {
        try {
          await auth.ssoExchange(assertion);
        } catch (err) {
          // 換發失敗（pk 不正確 / 驗章不過 / 後端拒絕）：直接顯示錯誤，不落到帳密登入頁。
          debugLog('④ 換發失敗，顯示錯誤畫面', err);
          setAuthError(t('auth.ssoFailed'));
          return null;
        }
        // 換發完成才發現已被登出蓋過：剛換到的這張票也要當場作廢，不能留著活到自然過期。
        if (identityEpochRef.current !== epoch) {
          auth.logout();
          return null;
        }
      } else {
        debugLog('③ 宿主頁沒給身分，落回自行登入');
      }
    }
    if (!auth.isAuthenticated()) return null;
    const me = await auth.me();
    // 「現在是誰在用小幫手」的最終答案：面板所有權限判定都以這份為準。
    debugLog('⑤ 目前登入者（GET /api/auth/me）', me);
    return identityEpochRef.current === epoch ? me : null;
  }

  // 啟動：還原登入狀態（有 token 就用 /me 取使用者）；並註冊 401（refresh 失敗）→ 登出
  useEffect(() => {
    // 登入後才發生的 401（且 refresh 也失敗）：多半是租戶金鑰(pk)不正確或伺服器無法連線。
    // 顯示整頁錯誤而非靜默掉回登入頁，避免「跳進聊天室又跳回登入頁」的閃爍。
    setUnauthorizedHandler(() => {
      setAuthUser(null);
      setAuthError(t('auth.sessionError'));
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
    // 面板就緒，向宿主頁握手（規格 §6.6）。未被嵌入時 hostBridge 停用，這行沒有副作用。
    hostBridge.handshake();
    // Session 續期（規格 §6.5 呼叫時機②）：到期前 60 秒由 api 層自行重走 token provider。
    // 註冊的就是首次取票用的那支 requestIdentity()——續期在協定上與初次取票完全相同，
    // 宿主頁不必為此多寫一行。沒有 provider（宿主未設 data-token-url）時 api 層不排程。
    if (embedConfig.identityAvailable) setIdentityProvider(() => hostBridge.requestIdentity());
    void (async () => {
      try {
        const me = await runSsoHandoff();
        if (me) setAuthUser(me);
      } catch {
        // 還原登入（me）失敗：401 已由 onUnauthorized 設好 authError；其餘（如伺服器無法連線）退回登入頁。
        setAuthUser(null);
      } finally {
        setAuthReady(true);
      }
    })();
     
  }, []);

  /**
   * 宿主網站登出／換人（規格 §6.3、§6.6，整合手冊 §5.3 登出、§5.4 切換帳號）。
   *
   * 面板的 Session 存在**面板自己網域**的 sessionStorage，宿主頁碰不到——只能由這裡清掉，
   * 並通知後端作廢（Session 是伺服器端有狀態的，只清瀏覽器等於留一張還能用的票）。
   * 處理完回一則 session:ack，宿主頁才知道可以放心導頁。
   *
   * 訂閱只掛一次：兩支 handler 只呼叫 setState 與模組層的 auth，沒有隨渲染改變的狀態；
   * 唯一的閉包值是錯誤訊息用的 t()，與上面的啟動流程同樣取自首次渲染那份。
   */
  useEffect(() => {
    if (!EMBED) return;
    const offLogout = hostBridge.on('session:logout', ({ requestId }) => {
      debugLog('宿主頁要求登出（session:logout）→ 作廢 Session 並清本地憑證');
      handleLogout();
      hostBridge.send('session:ack', { ok: true, type: 'session:logout' }, requestId);
    });
    const offRefresh = hostBridge.on('identity:refresh', ({ requestId }) => {
      void (async () => {
        debugLog('宿主頁要求重取身分（identity:refresh）→ 作廢舊 Session，重走握手');
        // 先作廢舊的再換新的：只換新的不作廢舊的，等於同一個瀏覽器同時有兩個人的票還活著。
        handleLogout();
        const epoch = identityEpochRef.current;
        let user: Applicant | null = null;
        try {
          user = await runSsoHandoff();
        } catch {
          user = null;
        }
        // 換到人就當作一次全新的登入：前一位的對話內容不留在畫面上。
        if (user && identityEpochRef.current === epoch) handleLogin(user);
        hostBridge.send('session:ack', { ok: !!user, type: 'identity:refresh' }, requestId);
      })();
    });
    return () => {
      offLogout();
      offRefresh();
    };
  }, []);

  // 登入後改用本人權限判定知識庫開場資料（開關＋推薦句）。
  // 依 authUser?.id 重跑：換人登入要重新判定，登出則清回 null（回到訪客那份，不殘留前一位的結果）。
  // 失敗時同樣清回 null——維持這支端點存在之前的行為，不因為多打一支 API 而讓 chip 整排消失。
  useEffect(() => {
    if (PREVIEW || !authUser) {
      setMemberFeed(null);
      return;
    }
    let cancelled = false;
    void api.knowledgeFeed()
      .then((feed) => { if (!cancelled) setMemberFeed(feed); })
      .catch(() => { if (!cancelled) setMemberFeed(null); });
    return () => { cancelled = true; };
    // 依 authUser 物件本身（而非 id）為相依：setAuthUser 只在登入／還原／登出三處呼叫，
    // 物件換新就是身分換了，不會有多餘重打
  }, [authUser]);

  const scrollToEnd = useCallback(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [messages, busy, scrollToEnd]);

  // 嵌入模式：以外層 widget.js 回報的放大狀態為準；Esc 在面板內按下時也要能還原
  // （焦點在 iframe 內時，宿主頁的 keydown 收不到，必須由這裡自己處理）。
  useEffect(() => {
    if (!EMBED) return;
    const offState = hostBridge.on<UiStatePayload>('ui:state', ({ payload }) => {
      const data = payload ?? {};
      setExpanded(!!data.expanded);
      if (typeof data.available === 'boolean') setCanExpand(data.available);
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setExpanded((cur) => {
        if (cur) hostBridge.send('ui:expand', { expanded: false });
        return false;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      offState();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

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

  // 可辦理的表單清單：登入後載入，供表單類型選單
  useEffect(() => {
    if (!authUser || PREVIEW) return;
    let alive = true;
    api
      .listForms()
      .then((list) => {
        if (!alive) return;
        setForms(list);
        // 一律不預選（含只有一張表單的租戶），使用者先選辦理項目才顯示該表單的動態提示按鈕；
        // 只有 embed 的 ?form= 會帶著預選進來
        setSelectedFormId((cur) => cur ?? pickInitialFormId(list, embedConfig.formId));
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

  function pushMsg(role: Role, text: string, suggestions?: string[], reportId?: string) {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role, text, suggestions, reportId, at: Date.now() },
    ]);
  }

  // 訊息動作：複製（AI/使用者皆可）與編輯（僅使用者訊息：帶回輸入框改完再送）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  async function copyMsg(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全環境（如 http iframe）fallback：暫時 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  }
  /** 編輯：把該則使用者訊息帶入輸入框（改完再送），不直接重送 */
  function editMsg(text: string) {
    setInput(text);
    taRef.current?.focus();
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
    // 報告不在這裡清：它掛在觸發它的那則訊息上，逐字稿還在就代表下載入口還有效
    // （切換表單 session 時訊息刻意保留，先前產生的報告仍應可再次開啟下載）
  }

  function handleLogin(user: Applicant) {
    setAuthUser(user);
    setMessages([{ id: nextId(), role: 'agent', text: greetingText, greeting: true, at: Date.now() }]);
  }

  function handleLogout() {
    setView('chat');
    // 先遞增世代：還在路上的取票／換發恢復執行時會發現自己已經過期，不會把 Session 寫回來。
    identityEpochRef.current += 1;
    auth.logout();
    setAuthUser(null);
    setBalances([]);
    resetSessionState();
  }

  // 錯誤畫面「重試」：清掉可能無效的 token，重載頁面重跑一次登入流程（嵌入時會重新嘗試 SSO）。
  function handleAuthRetry() {
    auth.logout();
    setAuthError(null);
    window.location.reload();
  }

  function applyTurn(data: TurnData, sessionId: string | null) {
    if (data.id) setConvId(data.id);
    // status 為上一輪的值（setState 尚未生效），用來判斷是否「剛進入」表單階段
    const prevStatus = status;
    setStatus(data.status);
    setValues(data.values ?? {});
    setSubmission(data.submission ?? null);
    // 本回合啟動了報告產生（僅報告服務會帶）：把 id 掛在這則回覆上，
    // 由該則訊息下方的膠囊按鈕負責輪詢與開啟下載彈窗
    if (data.reply) pushMsg('agent', data.reply, data.suggestions, data.report?.id);

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
        hostBridge.send('event', {
          name: 'oa-agent:submitted',
          detail: { submission: data.submission ?? null },
        });
      }
    }
  }

  async function openTask(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const restored = await api.getTask(id);
      const def = await api.getForm(restored.formId);
      // 兩個讀取都成功才替換目前對話，失敗時保留使用者原本的工作。
      setConvId(restored.id);
      setStatus(restored.status);
      setValues(restored.values);
      setSubmission(restored.submission ?? null);
      setSelectedFormId(restored.formId);
      setFormDef(def);
      setInput('');
      setPaneOpen(true);
      setMessages([{ id: nextId(), role: 'agent', at: Date.now(), text: t(
        restored.status === 'submitted' ? 'tasks.restoredSubmission' : 'tasks.restored',
        { title: def.data.title ?? restored.formId },
      ) }]);
      setShowForm(restored.status === 'confirming' || restored.status === 'submitted');
      setView('chat');
    } finally { setBusy(false); }
  }

  async function loadAndShowForm(sessionId: string | null) {
    if (!sessionId) return;
    try {
      // 一律以伺服器 session 的 formId 為準。formDef 可能殘留前一張表單（例如先辦過外出登記、
      // 再開請假對話），只用 if(!formDef) 會沿用舊 def，導致請假對話卻在確認畫面顯示外出表單。
      const conv = await api.getConversation(userId, sessionId);
      let def = formDef;
      if (!def || def.formId !== conv.formId) {
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
  // 知識庫推薦用詞：後端依租戶索引內容生成，沒有生成句就不顯示（不再回落寫死句）。
  // 已登入時整份改用本人權限判定的結果，見 resolveKnowledgeFeed。
  const knowledgeFeed = resolveKnowledgeFeed(
    { knowledgeEnabled, suggested: suggestedPrompts },
    memberFeed,
  );
  const knowledgePrompts = pickKnowledgePrompts({
    knowledgeEnabled: knowledgeFeed.knowledgeEnabled,
    language: i18n.language,
    suggested: knowledgeFeed.suggested,
  });

  // 建議回覆：只取「最新一則 agent 訊息」附帶的建議，作為可一鍵送出的快捷按鈕
  const lastMsg = messages[messages.length - 1];
  const replySuggestions = lastMsg?.role === 'agent' ? (lastMsg.suggestions ?? []) : [];

  function reset() {
    if (busy) return;
    setView('chat');
    setInput('');
    // 復用 resetSessionState 清全部 session 狀態（含 formDef）——先前此處是它的複製版但漏了
    // setFormDef(null)，導致「重新開始」後殘留前一張表單、下一張表單確認畫面顯示錯表單。
    resetSessionState();
    setMessages([
      { id: nextId(), role: 'agent', text: greetingText, greeting: true, at: Date.now() },
      { id: nextId(), role: 'sys', text: t('app.restarted'), at: Date.now() },
    ]);
    taRef.current?.focus();
  }

  // 嵌入模式：通知外層 widget.js 收起彈窗（widget.js 監聽此 message）。未被嵌入時 hostBridge 停用，無副作用。
  function closeWidget() {
    hostBridge.send('ui:close');
  }

  // 嵌入模式：請外層 widget.js 放大／還原面板（放大時 widget 會蓋上背景遮罩）。
  // 先樂觀更新本地狀態讓圖示即時反應，widget 完成後會回 oa-agent:expanded 校正（例如手機不放大）。
  function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    hostBridge.send('ui:expand', { expanded: next });
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
  // 登入／連線失敗：整頁錯誤 + 重試（優先於登入頁，避免靜默掉回帳密登入）
  if (authError) return <AuthErrorView message={authError} onRetry={handleAuthRetry} />;
  // 未登入：擋住整個 App，只顯示登入頁
  if (!authUser) return <LoginView onLogin={handleLogin} assistantName={aiName} />;

  // 標題列的組織資訊：SSO Assertion 的 hyagent:profile 或租戶人員目錄帶來的公司／部門／職稱。
  // 後端在查不到人時把部門填成 UNKNOWN_DEPARTMENT（'—'），那是「未建檔」的佔位符，
  // 顯示出來只會讓人以為系統壞了，所以濾掉——沒有組織資訊就只顯示姓名。
  const userOrg = [authUser.company, authUser.department, authUser.title]
    .filter((value) => value && value !== '—')
    .join(' ');

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
              {userOrg && <span className="app-meta-org">{userOrg}</span>}
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
            {/* 小視窗寬度有限，連線狀態／使用者／單況只在放大後才顯示（與整頁模式同一組樣式） */}
            {expanded && (
              <span
                className={`conn conn-${conn}`}
                role="status"
                aria-live="polite"
                title={t(`app.conn.${conn}`)}
              >
                <span className="conn-dot" aria-hidden="true" />
                {t(`app.conn.${conn}`)}
              </span>
            )}
          </div>
          <div className="embed-actions">
            {expanded && (
              <span className="embed-meta">
                <span className="app-meta-item">
                  <span className="app-meta-label">{t('app.user')}</span>
                  <span className="app-meta-value">{authUser.name}</span>
                  {userOrg && <span className="app-meta-org">{userOrg}</span>}
                </span>
                <span className="app-meta-sep" aria-hidden="true" />
                <Badge status={status ? STATUS_BADGE[status] : 'normal'}>
                  {status ? t(`app.status.${status}`) : t('app.statusInitial')}
                </Badge>
                <span className="app-meta-sep" aria-hidden="true" />
              </span>
            )}
            <button
              type="button"
              className={`embed-btn${expanded ? ' embed-btn-wide' : ''}`}
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
              {expanded && <span className="embed-btn-text">{t('app.reset')}</span>}
            </button>
            {/* 放大／還原：交給外層 widget.js 撐大面板並蓋遮罩 */}
            {canExpand && (
            <button
              type="button"
              className="embed-btn"
              onClick={toggleExpand}
              title={expanded ? t('app.collapseWidget') : t('app.expandWidget')}
              aria-label={expanded ? t('app.collapseWidget') : t('app.expandWidget')}
              aria-pressed={expanded}
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
                {expanded ? (
                  /* 還原：四角箭頭朝內 */
                  <>
                    <polyline points="9 3 9 9 3 9" />
                    <polyline points="15 3 15 9 21 9" />
                    <polyline points="9 21 9 15 3 15" />
                    <polyline points="15 21 15 15 21 15" />
                  </>
                ) : (
                  /* 放大：四角箭頭朝外 */
                  <>
                    <polyline points="3 9 3 3 9 3" />
                    <polyline points="21 9 21 3 15 3" />
                    <polyline points="3 15 3 21 9 21" />
                    <polyline points="21 15 21 21 15 21" />
                  </>
                )}
              </svg>
            </button>
            )}
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

      {!PREVIEW && <nav className="workspace-nav" aria-label={t('tasks.categories')}>
        <button type="button" aria-pressed={view === 'chat'} disabled={busy} onClick={() => setView('chat')}>{t('tasks.chat')}</button>
        <button type="button" aria-pressed={view === 'tasks'} disabled={busy || showForm} onClick={() => { setTaskTarget(undefined); setView('tasks'); }}>{t('tasks.title')}</button>
        <button type="button" aria-pressed={view === 'notifications'} disabled={busy || showForm} onClick={() => { setView('notifications'); void notifications.refresh(); }}>
          {t('notifications.title')}{notifications.feed.unreadCount > 0 && <span className="notification-badge" aria-label={t('notifications.unreadCount', { count: notifications.feed.unreadCount })}>{notifications.feed.unreadCount}</span>}
        </button>
      </nav>}
      {view === 'notifications' ? <NotificationCenter notifications={notifications} onOpen={async (item: TaskNotification) => {
        if (item.target.conversationId) await openTask(item.target.conversationId);
        else { setTaskTarget(item.target); setView('tasks'); }
      }} /> : view === 'tasks' ? <TaskCenter
        initialTarget={taskTarget}
        onOpen={openTask}
        onNew={reset}
        onCancelled={(id) => {
          if (convId === id) {
            resetSessionState();
            setInput('');
            setMessages([{ id: nextId(), role: 'sys', at: Date.now(), text: t('app.cancelledMsg') }]);
          }
        }}
      /> : <div className="app-body">
        <div className="chat-pane">
          {!PREVIEW && <MySkills key={authUser.id} />}
          <div className="msg-list" ref={listRef}>
            {messages.map((m) =>
              m.role === 'sys' ? (
                <div key={m.id} className="bubble bubble-sys">
                  {m.text}
                </div>
              ) : (
                <div key={m.id} className={`msg msg-${m.role}`}>
                  {/* 對象名稱：只在 AI 訊息顯示（使用者自己的訊息靠右即可辨識，不重複顯示名字） */}
                  {m.role === 'agent' && (
                    <span className="msg-name">
                      {logoUrl && <img src={logoUrl} alt="" className="msg-name-logo" />}
                      {aiName}
                    </span>
                  )}
                  {/* 泡泡＋時間動作列包成一組：寬度貼合泡泡，時間列因此對齊泡泡左緣（使用者訊息也是） */}
                  <div className="msg-body">
                  <div className={`bubble bubble-${m.role}`}>
                    {m.role === 'agent' ? (
                      <TypewriterText text={m.greeting ? greetingText : m.text} onTick={scrollToEnd} />
                    ) : (
                      m.text
                    )}
                  </div>
                  {/* 送出日期時間 + 訊息動作（hover 顯示 icon：複製；使用者訊息另有編輯。tooltip/aria 保留文字語意） */}
                  <span className="msg-meta">
                    <span className="msg-time">{formatTime(m.at)}</span>
                    {/* 報告入口：本則回覆啟動了報告產生時顯示，點開彈窗選格式下載。
                        與複製鈕同列同風格，但不隨 hover 隱藏——它帶狀態，藏起來使用者不會知道報告好了 */}
                    {m.reportId && <ReportStatus reportId={m.reportId} />}
                    <button
                      type="button"
                      className="msg-action"
                      title={copiedId === String(m.id) ? t('app.copiedMsg') : t('app.copyMsg')}
                      aria-label={t('app.copyMsg')}
                      onClick={() =>
                        void copyMsg(
                          String(m.id),
                          m.role === 'agent' && m.greeting ? greetingText : m.text,
                        )
                      }
                    >
                      {copiedId === String(m.id) ? (
                        /* 已複製：打勾 */
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        /* 複製：兩張疊起來的方框 */
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                    {m.role === 'user' && (
                      <button
                        type="button"
                        className="msg-action"
                        title={t('app.editMsg')}
                        aria-label={t('app.editMsg')}
                        onClick={() => editMsg(m.text)}
                      >
                        {/* 編輯：鉛筆（帶入輸入框，改完再送） */}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                    )}
                  </span>
                  </div>
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
          {!convId &&
            !busy &&
            shouldShowFormPicker({
              formCount: forms.length,
              knowledgePromptCount: knowledgePrompts.length,
            }) && (
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
                  {forms.map((f) => (
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
                  {/* 知識庫推薦用詞：網站來源與檔案來源各一顆 */}
                  {knowledgePrompts.map((p, i) => (
                    <button
                      key={`${p}-${i}`}
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

          {/* 開場引導：需先選定辦理項目，才顯示該表單的動態範例提示；隨「要辦理什麼？」一起收合 */}
          {!convId && !busy && pickerOpen && selectedFormId && quickPrompts.length > 0 && (
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
                <span className="kv-key">{formDef?.field[k]?.label ?? k}</span>
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
      </div>}

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
