/** 掃條碼閘門：相機會對同一張條碼連續觸發，只放行第一次；查詢失敗時釋放讓使用者重掃。 */
export function createScanGate() {
  let busy = false;
  return {
    tryAcquire(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    release(): void {
      busy = false;
    },
  };
}
