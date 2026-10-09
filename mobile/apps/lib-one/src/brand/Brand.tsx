/** Lib One 字標（官網 lib-one-logo.svg 輸出的高解析 PNG，assets/brand/logo.png）與 HyAgent 頭像。 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image, StyleSheet, View } from 'react-native';
import type { MascotPose } from '@hyagent/app-core/branding/AppBranding';
import { lib } from './theme';

const LOGO = require('../../assets/brand/logo.png');
/** logo 圖檔寬高比 1588:424 */
const LOGO_RATIO = 1588 / 424;

/** size＝字標高度 */
export function LibOneLogo({ size = 24 }: { size?: number }) {
  return <Image source={LOGO} style={{ height: size, width: size * LOGO_RATIO }} resizeMode="contain" accessibilityRole="header" accessibilityLabel="Lib One" />;
}

/** 對話與確認彈窗旁的 HyAgent：綠色圓底的星芒；錄音時換成麥克風。 */
export function HyAgentAvatar({ pose = 'idle', size }: { pose?: MascotPose; size: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]} accessibilityLabel="HyAgent">
      <MaterialCommunityIcons name={pose === 'mic' ? 'microphone' : 'star-four-points'} size={size * 0.52} color={lib.green} />
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { backgroundColor: lib.greenSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#CFE8D6' },
});
