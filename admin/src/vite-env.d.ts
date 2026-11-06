/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** production 設為後端絕對網址（如 https://api.example.com）；dev 留空走相對 /api（vite proxy） */
  readonly VITE_API_BASE?: string;
  /** production 設為 widget client（聊天前端）絕對網址（如 https://widget.example.com），供外觀預覽 iframe 使用；dev 留空走 localhost:5173 */
  readonly VITE_WIDGET_ORIGIN?: string;
  /** 「開啟示範網站」按鈕連到的外部網址；留空走預設 presale demo 網址 */
  readonly VITE_DEMO_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 執行期設定：由 /runtime-config.js 寫入（部署時 nginx 依環境變數產生） */
interface Window {
  __HYAGENT_ADMIN_CONFIG__?: {
    /** 外觀預覽 iframe 的 client 網址（WIDGET_ORIGIN） */
    widgetOrigin?: string;
    /** 「開啟示範網站」按鈕的網址（DEMO_SITE_URL） */
    demoSiteUrl?: string;
  };
}
