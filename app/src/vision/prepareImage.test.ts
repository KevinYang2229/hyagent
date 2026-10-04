const mockResize = jest.fn();
const mockSave = jest.fn(async () => ({ uri: 'file:///out.jpg', width: 1600, height: 1200 }));
const mockRender = jest.fn(async () => ({ saveAsync: mockSave }));
const mockManipulate = jest.fn(() => ({ resize: mockResize, renderAsync: mockRender }));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: (...a: unknown[]) => (mockManipulate as (...x: unknown[]) => unknown)(...a) },
  SaveFormat: { JPEG: 'jpeg' },
}));

import { prepareImage, resizeFor } from './prepareImage';

describe('resizeFor', () => {
  it('長邊超過 1600 才縮，依長邊方向', () => {
    expect(resizeFor(4000, 3000)).toEqual({ width: 1600 });
    expect(resizeFor(3000, 4000)).toEqual({ height: 1600 });
    expect(resizeFor(1600, 1200)).toBeNull();
    expect(resizeFor(800, 600)).toBeNull();
  });
});

describe('prepareImage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('大圖縮到 1600 並存成 JPEG 0.8', async () => {
    await expect(prepareImage({ uri: 'file:///in.jpg', width: 4000, height: 3000 })).resolves.toEqual({ uri: 'file:///out.jpg', width: 1600, height: 1200 });
    expect(mockManipulate).toHaveBeenCalledWith('file:///in.jpg');
    expect(mockResize).toHaveBeenCalledWith({ width: 1600 });
    expect(mockSave).toHaveBeenCalledWith({ compress: 0.8, format: 'jpeg' });
  });

  it('小圖不縮，但仍轉 JPEG', async () => {
    await prepareImage({ uri: 'file:///in.png', width: 800, height: 600 });
    expect(mockResize).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
  });
});
