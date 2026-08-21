/**
 * 嵌入模式設定：解析 widget iframe URL 上的查詢參數。
 *
 * widget.js 會把宿主頁的 data-* 設定轉成 query：
 *   /?embed=1&key=pk_xxx&form=leave-request&locale=zh-Hant&theme=dark&userToken=<jwt>
 *
 * 全部選填——未帶任何參數時等同改造前的純 ?embed=1 行為（向後相容）。
 */
import type { TenantAppearance } from '@hyagent/shared';
import type { SuggestedPrompts } from './knowledgePrompt';

type Theme = 'light' | 'dark';

const params = new URLSearchParams(window.location.search);

function pick(name: string): string | null {
  const v = params.get(name);
  return v && v.trim() ? v.trim() : null;
}

// 部署層預設租戶金鑰：單一 client 綁單一租戶時，於建置設 VITE_TENANT_KEY=pk_…
// 即可讓「非嵌入的首方使用」也吃到該租戶設定（表單／外觀）。URL ?key= 仍優先。
const envKey = (import.meta.env.VITE_TENANT_KEY ?? '').trim() || null;

export const embedConfig = {
  /** 是否為嵌入模式（widget iframe 載入） */
  embed: params.get('embed') === '1',
  /**
   * 純外觀預覽模式（後台 AppearanceTab 的即時預覽以 ?preview=1 載入）。
   * 跳過登入頁、以合成使用者渲染聊天面板外殼，且不呼叫任何後端（避免 401 被踢回登入）。
   */
  preview: params.get('preview') === '1',
  /**
   * 租戶公開金鑰（pk_…）；帶上後所有 API 請求附 x-api-key 供後端解析租戶。
   * 來源優先序：URL ?key=（widget 嵌入）> VITE_TENANT_KEY（部署預設）> 無（落到預設租戶）。
   */
  apiKey: pick('key') ?? envKey,
  /** 預選表單類型 */
  formId: pick('form'),
  /** 介面語言（zh-Hant / en…） */
  locale: pick('locale'),
  /** 外觀模式 */
  theme: (pick('theme') as Theme | null) ?? null,
  /** AI 名稱覆寫（後台預覽即時帶入；優先於後端外觀） */
  assistantName: pick('name'),
  /** SSO handoff：宿主簽發的終端使用者 token，換發本系統 token（免內部帳密登入） */
  userToken: pick('userToken'),
};

// API 來源：與 api.ts 同源。dev 留空走相對路徑（Vite proxy）；
// production 設 VITE_API_BASE 直接打 server（前後端分開部署時，相對路徑會打到靜態 client 網域而失敗）。
const API_ORIGIN = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/**
 * 讀後端外觀（依 apiKey 對應租戶）。失敗或未帶 key 回 {}。
 * 與 data-* 合併由呼叫端處理：data-* 優先。
 */
export interface WidgetConfig {
  appearance: TenantAppearance;
  /** 知識庫服務是否啟用（決定要不要顯示知識庫推薦用詞）；無 key/失敗時預設 true */
  knowledgeEnabled: boolean;
  /** 依各來源索引生成的推薦問句；未生成時為空陣列 */
  suggestedPrompts?: SuggestedPrompts[];
}

export async function fetchAppearance(): Promise<WidgetConfig> {
  if (!embedConfig.apiKey) return { appearance: {}, knowledgeEnabled: true };
  try {
    const url = `${API_ORIGIN}/api/widget/config?key=${encodeURIComponent(embedConfig.apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) return { appearance: {}, knowledgeEnabled: true };
    const json = (await res.json()) as {
      data?: {
        appearance?: TenantAppearance;
        knowledgeEnabled?: boolean;
        suggestedPrompts?: SuggestedPrompts[];
      };
    };
    return {
      appearance: json.data?.appearance ?? {},
      knowledgeEnabled: json.data?.knowledgeEnabled ?? true,
      suggestedPrompts: Array.isArray(json.data?.suggestedPrompts)
        ? json.data.suggestedPrompts
        : undefined,
    };
  } catch {
    return { appearance: {}, knowledgeEnabled: true };
  }
}
