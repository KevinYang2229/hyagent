/** LIB ONE 的品牌注入：HyAgent 頭像、語音範例；產品照之後由目錄的 image 欄位提供。 */
import { remoteImage, type AppBranding } from '@hyagent/app-core/branding/AppBranding';
import { HyAgentAvatar } from './Brand';

export const VOICE_EXAMPLES = ['「有哪些自助借還書設備？」', '「中小型圖書館適合哪一款？」', '「預約取書櫃可以放在館外嗎？」'];

export const libOneBranding: AppBranding = {
  Mascot: HyAgentAvatar,
  voiceExamples: VOICE_EXAMPLES,
  resolveImage: remoteImage,
};
