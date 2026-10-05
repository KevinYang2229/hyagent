/** Open醬與品牌標誌：依參考畫面重繪的素材放在 assets/brand。 */
import { Image } from 'react-native';

const MASCOT = {
  wave: require('../../assets/brand/mascot-wave-v2.png'),
  mic: require('../../assets/brand/mascot-mic-v2.png'),
  idle: require('../../assets/brand/mascot-idle-v2.png'),
} as const;

export type MascotPose = keyof typeof MASCOT;

export function Mascot({ pose, size }: { pose: MascotPose; size: number }) {
  return (
    <Image
      source={MASCOT[pose]}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel="Open醬"
    />
  );
}

export function BrandLogo({ height = 32, width = height * 4 }: { height?: number; width?: number }) {
  return (
    <Image
      source={require('../../assets/brand/logo-v2.png')}
      style={{ width, height }}
      resizeMode="contain"
      accessibilityLabel="7-ELEVEN"
    />
  );
}
