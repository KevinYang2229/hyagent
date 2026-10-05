import { ActivityIndicator, View } from 'react-native';
import { Mascot } from '@/brand/Mascot';
import { colors } from '@/theme/tokens';

export function SplashView() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: colors.bg }}>
      <Mascot pose="wave" size={140} />
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}
