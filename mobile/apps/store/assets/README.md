# App 本機圖片素材

圖片以內建 imagegen 生成。角色與標誌參照使用者截圖重繪；商品為展示用生成圖片。

| 路徑 | 內容 | 讀取方式 |
|---|---|---|
| `brand/store-background.png` | 門市模糊背景 | `APP_IMAGES.storeBackground`（首頁、登入） |
| `brand/chat-background.png` | 淡薄荷對話背景 | `APP_IMAGES.chatBackground`（AI 對話） |
| `brand/staff-avatar-home.png` | 店員頭像 | `APP_IMAGES.staffAvatar`（頂部列、我的） |
| `brand/app-icon.png` | Open醬 App 圖示 | `app.json` 的 icon / favicon / adaptiveIcon |
| `brand/logo-v2.png` | 7-ELEVEN 標誌 | `BrandLogo` |
| `brand/mascot-home.png` | 首頁專用半身 Open醬 | `APP_IMAGES.homeHero`（首頁） |
| `brand/mascot-wave-v2.png` | Open醬揮手 | `Mascot` 的 wave |
| `brand/mascot-mic-v2.png` | Open醬拿麥克風 | `Mascot` 的 mic |
| `brand/mascot-idle-v2.png` | Open醬待機 | `Mascot` 的 idle |
| `scenes/shelf-demo.png` | 貨架示範照片 | `APP_IMAGES.shelfDemo`（備用示範素材） |
| `products/P001.png`～`products/P020.png` | 20 個商品縮圖 | `PRODUCT_IMAGES` / `productImageSource` |

## 商品對應

| ID | 商品 |
|---|---|
| P001 | 鮭魚御飯糰 |
| P002 | 鮪魚御飯糰 |
| P003 | 明太子御飯糰 |
| P004 | 雞肉御飯糰 |
| P005 | 三明治－火腿蛋 |
| P006 | 三明治－鮪魚 |
| P007 | 沙拉－和風雞肉 |
| P008 | 沙拉－凱薩 |
| P009 | 便當－雞腿飯 |
| P010 | 便當－排骨飯 |
| P011 | 關東煮－蘿蔔 |
| P012 | 關東煮－黑輪 |
| P013 | 茶葉蛋 |
| P014 | 鮮奶 290ml |
| P015 | 無糖綠茶 600ml |
| P016 | 美式咖啡（中） |
| P017 | 拿鐵咖啡（中） |
| P018 | 布丁 |
| P019 | 麵包－菠蘿 |
| P020 | 優格 |

## 使用

```tsx
import { Image } from 'react-native';
import { APP_IMAGES } from '@/brand/assets';
import { productImageSource } from '@/brand/productImages';

<Image source={APP_IMAGES.shelfDemo} style={{ width: 480, height: 320 }} />
<Image source={productImageSource({ productId: 'P001' })} style={{ width: 48, height: 48 }} resizeMode="contain" />
```

Expo 使用靜態 `require` 打包本機圖片。已知商品依 ID、名稱或圖片檔名選擇本機素材，未知商品保留後端 HTTP(S) 圖片。不修改補貨單送往伺服器的圖片欄位。貨架與優惠券實際辨識仍使用使用者拍攝或選取的照片。

生成模式、完整提示與素材路徑記錄在 `generated-manifest.json`；首批品牌素材的提示重點見 `brand/README.md`。
