/** 各內容頁共用品牌列，操作按鈕不影響 Logo 的位置。 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SpaceMeLogo } from '@/brand/Brand';

export function BrandHeader({ wide, children }: { wide: boolean; children?: ReactNode }) {
  return (
    <View style={styles.row}>
      <SpaceMeLogo size={wide ? 30 : 24} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
