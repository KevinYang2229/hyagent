/** 各頁共用文字層級；手機與平板使用相同字重、色彩與行距比例。 */
import { StyleSheet } from 'react-native';
import { sm } from './theme';

const phone = StyleSheet.create({
  title: { fontSize: 30, lineHeight: 40, fontWeight: '900', color: sm.ink },
  subtitle: { fontSize: 20, lineHeight: 28, fontWeight: '800', color: sm.ink },
  description: { fontSize: 16, lineHeight: 28, fontWeight: '500', color: sm.inkSoft },
});
const tablet = StyleSheet.create({
  title: { ...phone.title, fontSize: 40, lineHeight: 52 },
  subtitle: { ...phone.subtitle, fontSize: 24, lineHeight: 34 },
  description: { ...phone.description, fontSize: 18, lineHeight: 30 },
});

export function pageTypography(wide: boolean) {
  return wide ? tablet : phone;
}
