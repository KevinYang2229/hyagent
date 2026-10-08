import { render, screen } from '@testing-library/react-native';
import { AppBrandingProvider } from '@hyagent/app-core/branding/AppBranding';
import { AssistantPanel } from '@hyagent/app-core/chat/AssistantPanel';
import { ConfirmModal } from '@hyagent/app-core/confirm/ConfirmModal';
import { FIELDS } from '@hyagent/app-core/confirm/fixtures';
import { storeBranding, VOICE_EXAMPLES } from './storeBranding';

const action = { id: 'a1', summary: { title: '建立補貨單', fields: [] }, form: { title: '建立補貨單', fields: FIELDS.slice(0, 2) }, expiresAt: '2099-01-01T00:00:00.000Z' };

it('補貨動作才有 Open醬陪伴，其他動作沒有', () => {
  expect(storeBranding.confirmCompanion?.('建立補貨單')).toMatchObject({ text: '確認後我就幫你\n送出補貨單囉！', label: 'Open醬揮手確認補貨' });
  expect(storeBranding.confirmCompanion?.('寄送通知')).toBeNull();
});

it('確認彈窗標頭顯示 Open醬', async () => {
  await render(
    <AppBrandingProvider value={storeBranding}>
      <ConfirmModal action={action} onConfirm={jest.fn()} onCancel={jest.fn()} now={0} />
    </AppBrandingProvider>,
  );
  expect(screen.getByText('Open醬')).toBeTruthy();
  expect(screen.getByLabelText('Open醬')).toBeTruthy();
});

it('助理面板列出門市語音範例', async () => {
  await render(
    <AppBrandingProvider value={storeBranding}>
      <AssistantPanel mode="idle" interaction="conversation" compact={false} micAvailable onInteractionChange={jest.fn()} onMicPress={jest.fn()} onStopPress={jest.fn()} onKeyboard={jest.fn()} onCamera={jest.fn()} />
    </AppBrandingProvider>,
  );
  expect(screen.getByText('你可以說：')).toBeTruthy();
  for (const e of VOICE_EXAMPLES) expect(screen.getByText(e)).toBeTruthy();
});
