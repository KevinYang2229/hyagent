import { createScanGate } from './scanGate';

it('第一次掃到才放行，失敗釋放後可再掃', () => {
  const gate = createScanGate();
  expect(gate.tryAcquire()).toBe(true);
  expect(gate.tryAcquire()).toBe(false);
  expect(gate.tryAcquire()).toBe(false);
  gate.release();
  expect(gate.tryAcquire()).toBe(true);
});

describe('失敗冷卻', () => {
  it('冷卻內相同條碼拒絕；不同條碼或冷卻結束後放行', () => {
    const gate = createScanGate();
    expect(gate.tryAcquire('A', 0)).toBe(true);
    gate.release({ cooldownMs: 2500, now: 0 });
    expect(gate.tryAcquire('A', 1000)).toBe(false);
    expect(gate.tryAcquire('B', 1000)).toBe(true);
    gate.release();
    expect(gate.tryAcquire('A', 2600)).toBe(true);
  });

  it('未帶冷卻的釋放可立即重掃同一條碼', () => {
    const gate = createScanGate();
    gate.tryAcquire('A', 0);
    gate.release();
    expect(gate.tryAcquire('A', 1)).toBe(true);
  });
});
