/** 品牌列（稿 01～06）：LIB ONE 字標、頁面標題；首頁以外有返回鍵，右側是設定。 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LibOneLogo } from '@/brand/Brand';
import { lib } from '@/brand/theme';

/** 依路徑決定標題；首頁與 HyAgent 只顯示字標 */
export function pageTitle(pathname: string): string | undefined {
  if (pathname === '/compare') return '產品比較';
  if (pathname.startsWith('/products/')) return '產品詳細';
  if (pathname === '/products') return '產品探索';
  if (pathname === '/contact') return '聯絡我們';
  return undefined;
}

/** HyAgent 頁右上的對話工具：朗讀開關、新對話 */
export interface ChatTools {
  speak: boolean;
  onToggleSpeak(): void;
  onNew(): void;
}

export function TopBar({ pathname, onBack, onSettings, chatTools }: { pathname: string; onBack(): void; onSettings(): void; chatTools?: ChatTools }) {
  const home = pathname === '/';
  const title = pageTitle(pathname);
  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: 'transparent' }}>
      <View style={styles.bar}>
        {home ? null : (
          <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回" style={styles.icon}>
            <Ionicons name="chevron-back" size={26} color={lib.ink} />
          </Pressable>
        )}
        <LibOneLogo size={home ? 36 : 30} />
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <View style={{ flex: 1 }} />
        {pathname === '/chat' && chatTools ? (
          <>
            <Pressable onPress={chatTools.onToggleSpeak} hitSlop={10} accessibilityRole="switch" accessibilityState={{ checked: chatTools.speak }} accessibilityLabel="朗讀回覆" style={styles.icon}>
              <Ionicons name={chatTools.speak ? 'volume-high-outline' : 'volume-mute-outline'} size={23} color={lib.inkSoft} />
            </Pressable>
            <Pressable onPress={chatTools.onNew} hitSlop={10} accessibilityRole="button" accessibilityLabel="新對話" style={styles.icon}>
              <Ionicons name="create-outline" size={23} color={lib.inkSoft} />
            </Pressable>
          </>
        ) : null}
        <Pressable onPress={onSettings} hitSlop={10} accessibilityRole="button" accessibilityLabel="設定" style={styles.icon}>
          <Ionicons name="settings-outline" size={23} color={lib.inkSoft} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20 },
  icon: { padding: 4 },
  title: { fontSize: 19, fontWeight: '800', color: lib.ink, marginLeft: 12 },
});
