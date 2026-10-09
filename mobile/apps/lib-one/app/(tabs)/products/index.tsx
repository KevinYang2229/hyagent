/** 產品探索路由：分類放在網址參數；畫面在 src/catalog/ProductsView.tsx。 */
import { router, useLocalSearchParams } from 'expo-router';
import { getCategory } from '@/catalog/catalog';
import { ProductsView } from '@/catalog/ProductsView';

export default function Products() {
  const params = useLocalSearchParams<{ category?: string }>();
  return (
    <ProductsView
      category={getCategory(params.category)?.id}
      onSelectCategory={(id) => router.setParams({ category: id ?? '' })}
      onOpenProduct={(id) => router.push({ pathname: '/products/[id]', params: { id } })}
      onCompare={() => router.navigate('/compare')}
    />
  );
}
