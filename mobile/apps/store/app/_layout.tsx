/** 根版面：品牌素材、資料快取、設定、登入、任務紅點；未登入只能到 /login。 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@hyagent/app-core/auth/AuthProvider';
import { storeBranding } from '@/brand/storeBranding';
import { AppBrandingProvider } from '@hyagent/app-core/branding/AppBranding';
import { SplashView } from '@/chrome/SplashView';
import { SettingsProvider } from '@hyagent/app-core/settings/SettingsProvider';
import { StoreChatProvider } from '@/tasks/StoreChatProvider';
import { TaskBadgeProvider } from '@/tasks/TaskBadge';
import { VisionResultProvider } from '@/vision/VisionResultStore';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

function RootStack() {
  const { status } = useAuth();
  if (status === 'loading') return <SplashView />;
  const signedIn = status === 'signedIn';
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="camera" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AppBrandingProvider value={storeBranding}>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <AuthProvider>
            <TaskBadgeProvider>
              <StatusBar style="dark" />
              <VisionResultProvider>
                <StoreChatProvider>
                  <RootStack />
                </StoreChatProvider>
              </VisionResultProvider>
            </TaskBadgeProvider>
          </AuthProvider>
        </SettingsProvider>
      </QueryClientProvider>
    </AppBrandingProvider>
  );
}
