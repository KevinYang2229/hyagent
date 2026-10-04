/** 集中登記本機素材；静態 require 讓 Expo/Metro 將圖片打包進 App。 */
export const APP_IMAGES = {
  homeHero: require('../../assets/brand/mascot-home.png'),
  storeBackground: require('../../assets/brand/store-background.png'),
  chatBackground: require('../../assets/brand/chat-background.png'),
  staffAvatar: require('../../assets/brand/staff-avatar-home.png'),
  shelfDemo: require('../../assets/scenes/shelf-demo.png'),
} as const;
