/** 本機商品縮圖：Expo 靜態 require，無需連線到門市圖片伺服器。 */
import type { ImageSourcePropType } from 'react-native';

export const PRODUCT_IMAGES: Record<string, ImageSourcePropType> = {
  P001: require('../../assets/products/P001.png'),
  P002: require('../../assets/products/P002.png'),
  P003: require('../../assets/products/P003.png'),
  P004: require('../../assets/products/P004.png'),
  P005: require('../../assets/products/P005.png'),
  P006: require('../../assets/products/P006.png'),
  P007: require('../../assets/products/P007.png'),
  P008: require('../../assets/products/P008.png'),
  P009: require('../../assets/products/P009.png'),
  P010: require('../../assets/products/P010.png'),
  P011: require('../../assets/products/P011.png'),
  P012: require('../../assets/products/P012.png'),
  P013: require('../../assets/products/P013.png'),
  P014: require('../../assets/products/P014.png'),
  P015: require('../../assets/products/P015.png'),
  P016: require('../../assets/products/P016.png'),
  P017: require('../../assets/products/P017.png'),
  P018: require('../../assets/products/P018.png'),
  P019: require('../../assets/products/P019.png'),
  P020: require('../../assets/products/P020.png'),
};

const PRODUCT_NAMES: Record<string, string> = {
  "鮭魚御飯糰": "P001",
  "鮭魚飯糰": "P001",
  "鮭魚三角飯糰": "P001",
  "鮪魚御飯糰": "P002",
  "鮪魚飯糰": "P002",
  "三角飯糰-鮪魚": "P002",
  "明太子御飯糰": "P003",
  "明太子飯糰": "P003",
  "雞肉御飯糰": "P004",
  "雞肉飯糰": "P004",
  "三明治－火腿蛋": "P005",
  "火腿蛋三明治": "P005",
  "火腿三明治": "P005",
  "三明治－鮪魚": "P006",
  "鮪魚三明治": "P006",
  "沙拉－和風雞肉": "P007",
  "和風雞肉沙拉": "P007",
  "雞肉沙拉": "P007",
  "沙拉－凱薩": "P008",
  "凱薩沙拉": "P008",
  "便當－雞腿飯": "P009",
  "雞腿便當": "P009",
  "雞腿飯": "P009",
  "便當－排骨飯": "P010",
  "排骨便當": "P010",
  "排骨飯": "P010",
  "關東煮－蘿蔔": "P011",
  "蘿蔔": "P011",
  "關東煮蘿蔔": "P011",
  "關東煮－黑輪": "P012",
  "黑輪": "P012",
  "茶葉蛋": "P013",
  "鮮奶 290ml": "P014",
  "鮮奶": "P014",
  "牛奶": "P014",
  "無糖綠茶 600ml": "P015",
  "綠茶": "P015",
  "無糖綠茶": "P015",
  "美式咖啡（中）": "P016",
  "美式咖啡": "P016",
  "黑咖啡": "P016",
  "拿鐵咖啡（中）": "P017",
  "拿鐵": "P017",
  "拿鐵咖啡": "P017",
  "布丁": "P018",
  "雞蛋布丁": "P018",
  "麵包－菠蘿": "P019",
  "菠蘿麵包": "P019",
  "優格": "P020",
  "原味優格": "P020",
};

function nameKey(name: string): string {
  return name.replace(/[\s－—–-]/g, '');
}
const normalizedNames = new Map(Object.entries(PRODUCT_NAMES).map(([name, id]) => [nameKey(name), id]));

/** 優先本機已知商品，未知商品保留後端圖片網址；不修改送往工具的資料。 */
export function productImageSource(item: { productId?: unknown; name?: unknown; image?: unknown }): ImageSourcePropType | undefined {
  const id = typeof item.productId === 'string' ? item.productId : undefined;
  if (id && Object.prototype.hasOwnProperty.call(PRODUCT_IMAGES, id)) return PRODUCT_IMAGES[id];
  const byName = typeof item.name === 'string' ? normalizedNames.get(nameKey(item.name)) : undefined;
  if (byName) return PRODUCT_IMAGES[byName];
  if (typeof item.image === 'string' && /^https?:\/\//i.test(item.image)) {
    const fileId = /\/(P\d{3})\.(?:png|jpe?g|webp)(?:[?#]|$)/i.exec(item.image)?.[1]?.toUpperCase();
    if (fileId && Object.prototype.hasOwnProperty.call(PRODUCT_IMAGES, fileId)) return PRODUCT_IMAGES[fileId];
    return { uri: item.image };
  }
  return undefined;
}
