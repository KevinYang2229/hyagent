/** SpaceMe 的品牌注入：HyAgent 機器人頭像、語音範例；圖片只用後端給的網址。 */
import { remoteImage, type AppBranding } from '@hyagent/app-core/branding/AppBranding';
import { HyAgentMascot } from './Brand';
import { sm } from './theme';

export const VOICE_EXAMPLES = ['「圖書館空間管理有哪些功能？」', '「討論室可以怎麼預約？」', '「OfficeMe 適合哪些企業？」'];

export const spaceMeBranding: AppBranding = {
  Mascot: HyAgentMascot,
  voiceExamples: VOICE_EXAMPLES,
  resolveImage: remoteImage,
  accent: { primary: sm.blue, primaryDark: sm.blueDark, primarySoft: sm.blueSoft },
};
