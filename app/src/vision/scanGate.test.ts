import { createScanGate } from './scanGate';

it('第一次掃到才放行，失敗釋放後可再掃', () => {
  const gate = createScanGate();
  expect(gate.tryAcquire()).toBe(true);
  expect(gate.tryAcquire()).toBe(false);
  expect(gate.tryAcquire()).toBe(false);
  gate.release();
  expect(gate.tryAcquire()).toBe(true);
});
