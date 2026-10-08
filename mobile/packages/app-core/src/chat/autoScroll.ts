/** 對話是否要自動捲到底：訊息數或「思考中」狀態改變，或使用者本來就在底部附近。 */
export const NEAR_BOTTOM_PX = 80;

export function isNearBottom(layoutHeight: number, contentHeight: number, offsetY: number): boolean {
  return contentHeight - (offsetY + layoutHeight) <= NEAR_BOTTOM_PX;
}

export function shouldAutoScroll(o: {
  prevCount: number;
  count: number;
  prevSending: boolean;
  sending: boolean;
  nearBottom: boolean;
}): boolean {
  return o.count !== o.prevCount || o.sending !== o.prevSending || o.nearBottom;
}
