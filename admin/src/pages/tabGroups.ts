import type { SVGProps } from 'react';
import {
  IconAudit, IconBook, IconChart, IconCog, IconDatabase, IconForm, IconLogin, IconMessage,
  IconOverview, IconPalette, IconReport, IconShield, IconSparkle, IconSync, IconUsers, IconWebhook,
} from '../components/icons';

export type TabKey =
  | 'overview'
  | 'sso'
  | 'users'
  | 'directorySync'
  | 'appearance'
  | 'forms'
  | 'knowledge'
  | 'database'
  | 'permissions'
  | 'settings'
  | 'ai'
  | 'webhook'
  | 'usage'
  | 'reports'
  | 'feedback'
  | 'audit'
  | 'adminAccounts';

/**
 * 依導入流程分組：接入 → 人員與登入 → 內容與能力 → 權限（把內容開給人）→ 前台呈現 → 營運。
 * 權限排在內容之後：要先有表單、知識庫標籤、外部服務，才有東西可以授權。
 * 網址的 tab key 不變，既有連結與書籤仍有效。
 */
type NavIcon = (props: SVGProps<SVGSVGElement>) => JSX.Element;
export const TAB_GROUPS: { label: string | null; tabs: { key: TabKey; label: string; icon: NavIcon }[] }[] = [
  { label: null, tabs: [{ key: 'overview', label: '總覽', icon: IconOverview }] },
  { label: '接入', tabs: [
    { key: 'settings', label: '基本設定', icon: IconCog },
    { key: 'ai', label: 'AI 模型', icon: IconSparkle },
  ] },
  { label: '人員與登入', tabs: [
    { key: 'sso', label: '自動登入（SSO）', icon: IconLogin },
    { key: 'users', label: '使用者目錄', icon: IconUsers },
    { key: 'directorySync', label: '人員同步', icon: IconSync },
  ] },
  { label: '內容與能力', tabs: [
    { key: 'knowledge', label: '知識庫', icon: IconBook },
    { key: 'forms', label: '表單', icon: IconForm },
    { key: 'database', label: '資料庫查詢', icon: IconDatabase },
  ] },
  { label: '權限', tabs: [
    { key: 'permissions', label: '角色與授權', icon: IconShield },
    { key: 'adminAccounts', label: '後台管理者', icon: IconUsers },
  ] },
  { label: '前台呈現', tabs: [
    { key: 'appearance', label: '外觀', icon: IconPalette },
    { key: 'webhook', label: '事件通知（Webhook）', icon: IconWebhook },
  ] },
  { label: '營運', tabs: [
    { key: 'usage', label: '用量', icon: IconChart },
    { key: 'feedback', label: '回饋', icon: IconMessage },
    { key: 'reports', label: '報告', icon: IconReport },
    { key: 'audit', label: '稽核', icon: IconAudit },
  ] },
];

/** 分頁中文名稱查詢（權限編輯等畫面沿用，不另寫一份） */
export const TAB_LABELS: Record<TabKey, string> = Object.fromEntries(
  TAB_GROUPS.flatMap((g) => g.tabs.map((t) => [t.key, t.label])),
) as Record<TabKey, string>;
