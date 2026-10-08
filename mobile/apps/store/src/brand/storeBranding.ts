/** 7-ELEVEN 門市版的品牌注入：Open醬、門市語音範例、本機商品圖、補貨確認的陪伴角色。 */
import type { AppBranding } from '@hyagent/app-core/branding/AppBranding';
import { Mascot } from './Mascot';
import { productImageSource } from './productImages';

export const VOICE_EXAMPLES = ['「查詢御飯糰的庫存」', '「建立補貨單」', '「今天有哪些即期品？」', '「咖啡機紅燈怎麼處理？」'];

export const storeBranding: AppBranding = {
  Mascot,
  voiceExamples: VOICE_EXAMPLES,
  resolveImage: productImageSource,
  confirmHeader: { name: 'Open醬', image: require('../../assets/brand/mascot-home.png') },
  confirmCompanion: (title) =>
    title.includes('補貨')
      ? { text: '確認後我就幫你\n送出補貨單囉！', image: require('../../assets/brand/mascot-confirm.png'), label: 'Open醬揮手確認補貨' }
      : null,
};
