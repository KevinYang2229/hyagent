import { canInteract } from './cameraGuard';

it('忙碌時不可切換模式或拍照', () => {
  expect(canInteract(true)).toBe(false);
  expect(canInteract(false)).toBe(true);
});
