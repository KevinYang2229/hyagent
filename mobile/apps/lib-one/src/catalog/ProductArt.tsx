/**
 * 產品展示底（稿 02～06 的產品圖區）：白到淺綠的漸層、淡綠弧線與地面陰影，產品去背照放在上面。
 * 沒有產品照時改用大圖示。
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { lib } from '@/brand/theme';
import type { ArtIcon, Product } from './catalog';

export function ProductArt({ icon, image, size, label, style, fill = 0.8 }: {
  icon: ArtIcon;
  image?: Product['image'];
  size: number;
  label: string;
  style?: StyleProp<ViewStyle>;
  /** 產品照佔展示底高度的比例 */
  fill?: number;
}) {
  return (
    <View style={[styles.stage, { height: size }, style]} accessibilityRole="image" accessibilityLabel={label}>
      <LinearGradient colors={['#FFFFFF', '#F1F7F2', '#DDEEE1']} locations={[0, 0.55, 1]} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={[styles.arc, { width: size * 2.2, height: size * 2.2, borderRadius: size * 1.1, right: -size * 1.35, top: -size * 0.55 }]} />
      {/* 地面陰影：三層由大到小的淡色橢圓疊出柔邊 */}
      {[1, 0.78, 0.56].map((k) => (
        <View key={k} pointerEvents="none" style={[styles.floor, { width: `${72 * k}%`, height: size * 0.07 * k, bottom: size * (0.06 + (1 - k) * 0.035) }]} />
      ))}
      {image ? (
        <Image source={image} style={{ width: '86%', height: size * fill, marginBottom: size * 0.04 }} resizeMode="contain" />
      ) : (
        <MaterialCommunityIcons name={icon} size={size * 0.5} color={lib.greenDark} style={{ marginBottom: size * 0.2 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden', borderRadius: 16, backgroundColor: lib.greenMist },
  arc: { position: 'absolute', borderWidth: 2, borderColor: 'rgba(61,170,92,0.18)' },
  floor: { position: 'absolute', alignSelf: 'center', borderRadius: 999, backgroundColor: 'rgba(30,80,50,0.045)' },
});
