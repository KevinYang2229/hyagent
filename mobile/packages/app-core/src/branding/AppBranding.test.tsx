import { render, screen } from '@testing-library/react-native';
import { AssistantPanel } from '@hyagent/app-core/chat/AssistantPanel';
import { remoteImage } from './AppBranding';

it('沒注入品牌時不顯示範例句', async () => {
  await render(<AssistantPanel mode="idle" interaction="conversation" compact={false} micAvailable onInteractionChange={jest.fn()} onMicPress={jest.fn()} onStopPress={jest.fn()} onKeyboard={jest.fn()} onCamera={jest.fn()} />);
  expect(screen.queryByText('你可以說：')).toBeNull();
  expect(screen.getByLabelText('開始說話')).toBeTruthy();
});

it('預設圖片來源只接受 http(s) 網址', () => {
  expect(remoteImage({ image: 'https://s/P001.png' })).toEqual({ uri: 'https://s/P001.png' });
  expect(remoteImage({ image: 'javascript:alert(1)' })).toBeUndefined();
  expect(remoteImage({ name: '鮭魚御飯糰' })).toBeUndefined();
});
