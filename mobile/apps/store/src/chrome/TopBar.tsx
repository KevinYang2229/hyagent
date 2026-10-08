/** 品牌列：首頁透出門市背景，其他頁面使用白色底。 */
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApi, useAuth } from '@hyagent/app-core/auth/AuthProvider';
import { APP_IMAGES } from '@/brand/assets';
import { BrandLogo } from '@/brand/Mascot';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';

export const STORE_NAME = process.env.EXPO_PUBLIC_STORE_NAME || '中山門市';

export function TopBar({ home = false }: { home?: boolean }) {
  const wide = useIsWide();
  const api = useApi();
  const { user } = useAuth();
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications(), refetchInterval: 60_000 });
  return <StoreHeaderView wide={wide} home={home} name={user?.name ?? ''} role={user?.title ?? '店員'} unread={notifications.data?.unreadCount ?? 0} />;
}

export function StoreHeaderView({ wide, home, name, role, unread }: { wide: boolean; home: boolean; name: string; role: string; unread: number }) {
  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: home ? 'transparent' : '#FFFFFF' }}>
      <View style={[styles.bar, { height: wide ? 64 : 56, gap: wide ? 16 : 10 }]}>
        <View style={styles.logoTile}><BrandLogo height={wide ? 44 : 28} width={wide ? 144 : 112} /></View>
        {wide ? <View style={styles.store}>
          <Ionicons name="chatbox-ellipses-outline" size={21} color="#192D50" />
          <Text style={styles.storeText}>{STORE_NAME}</Text>
          <Ionicons name="chevron-down" size={13} color="#192D50" />
        </View> : null}
        <View style={{ flex: 1 }} />
        <View accessibilityLabel={`通知 ${unread} 則未讀`} style={styles.bell}>
          <Ionicons name="notifications-outline" size={27} color="#192D50" />
          {unread > 0 ? <View style={styles.dot}><Text style={styles.dotText}>{unread > 99 ? '99+' : unread}</Text></View> : null}
        </View>
        <View style={[styles.staff, !wide && { minWidth: 44 }]}>
          <Image source={APP_IMAGES.staffAvatar} style={styles.avatar} accessibilityLabel="店員頭像" />
          {wide ? <View style={{ gap: 3 }}><Text style={styles.name}>{name}</Text><Text style={styles.role}>{role}</Text></View> : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20 },
  logoTile: { backgroundColor: 'rgba(255,255,255,0.88)', borderBottomLeftRadius: 16, borderBottomRightRadius: 16, paddingHorizontal: 10, height: '100%', justifyContent: 'center' },
  store: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 12 },
  storeText: { fontSize: 16, fontWeight: '700', color: '#192D50' },
  bell: { padding: 5, marginRight: 12 },
  dot: { position: 'absolute', top: 0, right: 0, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: '#FF242D', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  dotText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  staff: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 116 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#DFF4FC' },
  name: { fontSize: 15, fontWeight: '700', color: '#192D50' },
  role: { fontSize: 13, color: '#7C889C', fontWeight: '600' },
});
