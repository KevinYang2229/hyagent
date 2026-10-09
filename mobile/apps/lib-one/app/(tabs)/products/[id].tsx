/** 產品詳細頁路由：找產品、接比較清單與導頁；畫面在 src/catalog/ProductDetailView.tsx（稿 06）。 */
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { lib } from '@/brand/theme';
import { askAboutProduct } from '@/catalog/agentBridge';
import { getProduct } from '@/catalog/catalog';
import { useCompare } from '@/catalog/CompareStore';
import { ProductDetailView } from '@/catalog/ProductDetailView';
import { chatRoute } from '@/navigation/chatRoute';

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const product = getProduct(id);
  const wide = useIsWide();
  const { width, height } = useWindowDimensions();
  const compare = useCompare();
  if (!product) {
    return (
      <View style={styles.missing}>
        <Text style={styles.text}>找不到這項產品。</Text>
        <Pressable onPress={() => router.navigate('/products')} accessibilityRole="button"><Text style={styles.link}>回產品探索</Text></Pressable>
      </View>
    );
  }
  return (
    <ProductDetailView
      product={product}
      wide={wide}
      width={width}
      height={height}
      inCompare={compare.has(product.id)}
      onOpen={(p) => router.setParams({ id: p.id })}
      onContact={() => router.navigate({ pathname: '/contact', params: { product: product.id } })}
      onAsk={() => router.navigate(chatRoute({ q: askAboutProduct(product) }))}
      onToggleCompare={() => compare.toggle(product.id)}
    />
  );
}

const styles = StyleSheet.create({
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  text: { fontSize: 18, color: lib.inkSoft },
  link: { fontSize: 17, fontWeight: '700', color: lib.greenDark },
});
