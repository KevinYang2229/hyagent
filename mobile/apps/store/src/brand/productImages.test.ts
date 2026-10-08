import { PRODUCT_IMAGES, productImageSource } from './productImages';

it('在門市圖片伺服器無法連線時，商品 ID 仍會選用本機圖片', () => {
  expect(productImageSource({ productId: 'P001', image: 'http://localhost:4200/assets/P001.png' })).toBe(PRODUCT_IMAGES.P001);
});

it('没有 ID 時可由商品名稱與不同破折號辨識商品', () => {
  expect(productImageSource({ name: '三明治 - 火腿蛋' })).toBe(PRODUCT_IMAGES.P005);
  expect(productImageSource({ name: '鮭魚飯糰' })).toBe(PRODUCT_IMAGES.P001);
});

it('只有帶 query 的圖片網址時也能辨識商品', () => {
  expect(productImageSource({ image: 'https://store/assets/P003.png?v=2' })).toBe(PRODUCT_IMAGES.P003);
});

it('未知商品保留遠端圖片，不使用猜測商品的縮圖', () => {
  expect(productImageSource({ productId: 'P999', name: '新商品', image: 'https://store/new.png' })).toEqual({ uri: 'https://store/new.png' });
});

it('缺圖與非法輸入不會被當成可顯示的圖片', () => {
  expect(productImageSource({ productId: 'toString', image: 'javascript:alert(1)' })).toBeUndefined();
  expect(productImageSource({ name: null, image: 42 })).toBeUndefined();
});
