/** 「聯絡我們」的業務窗口：由環境變數提供，沒設定的管道不顯示。 */
export interface ContactChannel {
  kind: 'phone' | 'email' | 'website';
  label: string;
  value: string;
  url: string;
}

export function contactChannels(env: { phone?: string; email?: string; website?: string }, subject?: string): ContactChannel[] {
  const list: ContactChannel[] = [];
  const phone = env.phone?.trim();
  const email = env.email?.trim();
  const website = env.website?.trim();
  if (phone) list.push({ kind: 'phone', label: '電話', value: phone, url: `tel:${phone.replace(/[^\d+]/g, '')}` });
  if (email) list.push({ kind: 'email', label: '電子郵件', value: email, url: `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}` });
  if (website) list.push({ kind: 'website', label: '網站', value: website, url: /^https?:\/\//i.test(website) ? website : `https://${website}` });
  return list;
}

export const CONTACT_ENV = {
  phone: process.env.EXPO_PUBLIC_CONTACT_PHONE,
  email: process.env.EXPO_PUBLIC_CONTACT_EMAIL,
  // 沒設定時不顯示
  website: process.env.EXPO_PUBLIC_CONTACT_WEBSITE,
};
