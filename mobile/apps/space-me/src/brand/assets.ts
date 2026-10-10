/** 本機照片：靜態 require 讓 Metro 打包進 App。來源見 assets/README.md。 */
export const PHOTOS = {
  hero: require('../../assets/photos/hero.png'),
  pageBackground: require('../../assets/photos/space-me-background.jpg'),
  contactBackground: require('../../assets/photos/features-glass-background.jpg'),
  featuresBackground: require('../../assets/photos/contact-background.jpg'),
  library: require('../../assets/photos/solution-library-banner.jpg'),
  office: require('../../assets/photos/solution-office-banner.jpg'),
  environment: require('../../assets/photos/solution-environment-banner.jpg'),
  consulting: require('../../assets/photos/solution-consulting-banner.jpg'),
  roomDiscussion: require('../../assets/photos/room-discussion.png'),
  roomStudy: require('../../assets/photos/room-study.png'),
  roomReading: require('../../assets/photos/room-reading.png'),
} as const;

export type PhotoKey = keyof typeof PHOTOS;

/** 首頁專用高解析度情境圖，避免使用設計稿的小尺寸裁圖。 */
export const HOME_PHOTOS = {
  library: require('../../assets/photos/home-library.jpg'),
  office: require('../../assets/photos/home-office.jpg'),
  success: require('../../assets/photos/home-success.jpg'),
  demo: require('../../assets/photos/home-demo.jpg'),
} as const;
