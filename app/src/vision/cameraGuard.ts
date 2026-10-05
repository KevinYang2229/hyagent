/** 相機忙碌（辨識／查券進行中）時，模式切換與拍照都必須無效，只留關閉鈕。 */
export function canInteract(busy: boolean): boolean {
  return !busy;
}
