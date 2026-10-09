/** 聯絡我們路由：從產品頁進來時帶入諮詢產品；畫面在 src/contact/ContactView.tsx。 */
import { router, useLocalSearchParams } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { getProduct } from '@/catalog/catalog';
import { CONTACT_ENV, contactChannels } from '@/contact/contact';
import { ContactView } from '@/contact/ContactView';
import { chatRoute } from '@/navigation/chatRoute';

export default function Contact() {
  const { product: productId } = useLocalSearchParams<{ product?: string }>();
  const { width } = useWindowDimensions();
  const product = getProduct(productId);
  const subject = product ? `LIB ONE 產品諮詢：${product.name}` : 'LIB ONE 產品諮詢';
  const prepare = product
    ? `我想諮詢「${product.name}」，請幫我整理聯絡業務前需要準備的館舍資訊`
    : '我想諮詢 LIB ONE 導入方案，請幫我整理聯絡業務前需要準備的館舍資訊';
  return (
    <ContactView
      wide={width >= 700}
      product={product}
      channels={contactChannels(CONTACT_ENV, subject)}
      onPrepare={() => router.navigate(chatRoute({ q: prepare }))}
      onClearProduct={() => router.setParams({ product: '' })}
      onAsk={(q) => router.navigate(chatRoute({ q }))}
    />
  );
}
