/** 頂部列：標誌、門市（固定一間）、通知數、店員資訊；窄版只留標誌、通知與頭像。 */
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApi, useAuth } from '@/auth/AuthProvider';
import { BrandLogo } from '@/brand/Mascot';
import { useIsWide } from '@/layout/useIsWide';
import { colors, font, radius, space } from '@/theme/tokens';

export const STORE_NAME = process.env.EXPO_PUBLIC_STORE_NAME || '中山門市';

export function TopBar() {
  const wide = useIsWide();
  const api = useApi();
  const { user } = useAuth();
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications(), refetchInterval: 60_000 });
  const unread = notifications.data?.unreadCount ?? 0;
  const initial = (user?.name ?? '?').slice(0, 1);

  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <View style={styles.bar}>
        <BrandLogo height={wide ? 32 : 26} />
        {wide && (
          <View style={styles.store}>
            <Ionicons name="storefront-outline" size={16} color={colors.textMuted} />
            <Text style={styles.storeText}>{STORE_NAME}</Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        <View accessibilityLabel={`通知 ${unread} 則未讀`} style={styles.bell}>
          <Ionicons name="notifications-outline" size={24} color={colors.text} />
          {unread > 0 && (
            <View style={styles.dot}>
              <Text style={styles.dotText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </View>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        {wide && (
          <View>
            <Text style={styles.name}>{user?.name ?? ''}</Text>
            <Text style={styles.role}>{user?.title ?? '店員'}</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  store: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.bg, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 6 },
  storeText: { fontSize: font.md, color: colors.text },
  bell: { padding: 4 },
  dot: { position: 'absolute', top: -2, right: -4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  dotText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primaryDark, fontWeight: '700', fontSize: font.md },
  name: { fontSize: font.md, fontWeight: '600', color: colors.text },
  role: { fontSize: font.sm, color: colors.textMuted },
});
