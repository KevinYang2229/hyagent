import type { FieldLink, FieldSpec } from './form.types';

const DEMO_LEGAL_LINKS = {
  terms: { label: '服務條款', url: '/legal/terms.html' },
  privacy: { label: '隱私權政策', url: '/legal/privacy.html' },
  personalData: { label: '個人資料蒐集告知事項', url: '/legal/personal-data.html' },
} as const;

/** Server 執行期不直接 import @hyagent/shared：部署映像僅帶編譯後的 server/dist。 */
export function isSafeFieldLinkUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url);
}

export function resolveFieldLinks(spec: FieldSpec): FieldLink[] {
  if (spec.links?.length) {
    return spec.links.filter((link) => link.label.trim() !== '' && isSafeFieldLinkUrl(link.url));
  }
  const text = `${spec.label} ${spec.help ?? ''}`;
  const links: FieldLink[] = [];
  if (text.includes('服務條款')) links.push(DEMO_LEGAL_LINKS.terms);
  if (text.includes('隱私權政策')) links.push(DEMO_LEGAL_LINKS.privacy);
  if (/個人資料|個資/.test(text)) links.push(DEMO_LEGAL_LINKS.personalData);
  return links;
}

export function requiresExplicitConsent(spec: FieldSpec | undefined): boolean {
  if (!spec) return false;
  return spec.requiresTrue === true || (
    spec.component === 'Checkbox'
    && /(同意|服務條款|隱私權|個人資料|個資)/.test(`${spec.label} ${spec.help ?? ''}`)
  );
}
