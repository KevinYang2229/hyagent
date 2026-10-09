/** HyAgent 回覆提到的產品卡（稿 02）：平板一列三張、手機橫向滑動。 */
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { productsMentioned } from '@/catalog/agentBridge';
import { ProductFeatureCard } from '@/catalog/ProductCards';

export function ProductStrip({ text, wide }: { text: string; wide: boolean }) {
  const products = productsMentioned(text);
  if (products.length === 0) return null;
  const open = (id: string) => router.push({ pathname: '/products/[id]', params: { id } });
  if (wide && products.length <= 3) {
    return (
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 4, marginBottom: 12 }}>
        {products.map((p) => <ProductFeatureCard key={p.id} product={p} onOpen={() => open(p.id)} />)}
        {/* 不足三張時補空位，卡片寬度維持一致 */}
        {Array.from({ length: 3 - products.length }, (_, i) => <View key={i} style={{ flex: 1 }} />)}
      </View>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 4, paddingRight: 12 }} style={{ marginBottom: 12 }}>
      {products.map((p) => <ProductFeatureCard key={p.id} product={p} width={wide ? 300 : 250} onOpen={() => open(p.id)} />)}
    </ScrollView>
  );
}
