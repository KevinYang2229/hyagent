/** Open醬與品牌標誌：圖檔放在 assets/brand（目前為占位圖）。 */
import { Image } from 'react-native';

const MASCOT = {
  wave: require('../../assets/brand/mascot-wave.png'),
  mic: require('../../assets/brand/mascot-mic.png'),
  idle: require('../../assets/brand/mascot-idle.png'),
} as const;

export type MascotPose = keyof typeof MASCOT;

export function Mascot({ pose, size }: { pose: MascotPose; size: number }) {
  return (
    <Image
      source={MASCOT[pose]}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      resizeMode="contain"
      accessibilityLabel="Open醬"
    />
  );
}

export function BrandLogo({ height = 32 }: { height?: number }) {
  return (
    <Image
      source={require('../../assets/brand/logo.png')}
      style={{ width: height * 4, height, borderRadius: 6 }}
      resizeMode="contain"
      accessibilityLabel="7-ELEVEN"
    />
  );
}
