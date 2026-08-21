/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 後端 API 來源網域（前後端分開部署時設定，例：https://hyagent-server.zeabur.app）。
   *  dev 留空 → 走相對路徑由 Vite proxy 代理到 localhost:3000。 */
  readonly VITE_API_BASE?: string;
  /** 部署層預設租戶公開金鑰（pk_…）：單一 client 綁單一租戶時設定，
   *  讓非嵌入的首方使用也吃到該租戶設定。URL ?key= 仍優先。 */
  readonly VITE_TENANT_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
