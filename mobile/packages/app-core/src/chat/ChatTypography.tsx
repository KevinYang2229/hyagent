import { createContext, useContext } from 'react';
import { chatFont } from '@hyagent/app-core/theme/tokens';

export interface ChatTypography {
  body: number;
  lineHeight: number;
  label: number;
  caption: number;
}

/** 各 App 可調整對話字級；未指定時沿用共用預設值。 */
export const ChatTypographyContext = createContext<ChatTypography>(chatFont);
export const useChatTypography = () => useContext(ChatTypographyContext);
