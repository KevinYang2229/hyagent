/** 本機照片：靜態 require 讓 Metro 打包進 App。來源見 assets/README.md。 */
export const PHOTOS = {
  hero: require('../../assets/photos/hero.png'),
  library: require('../../assets/photos/library.png'),
  office: require('../../assets/photos/office.png'),
  environment: require('../../assets/photos/environment.png'),
  consulting: require('../../assets/photos/consulting.png'),
  roomDiscussion: require('../../assets/photos/room-discussion.png'),
  roomStudy: require('../../assets/photos/room-study.png'),
  roomReading: require('../../assets/photos/room-reading.png'),
} as const;

export type PhotoKey = keyof typeof PHOTOS;
