/** 根版面：資料快取、設定、登入、任務紅點；未登入只能到 /login。 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { ChatProvider } from '@/chat/ChatProvider';
import { SplashView } from '@/chrome/SplashView';
import { SettingsProvider } from '@/settings/SettingsProvider';
import { TaskBadgeProvider } from '@/tasks/TaskBadge';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

function RootStack() {
  const { status } = useAuth();
  if (status === 'loading') return <SplashView />;
  const signedIn = status === 'signedIn';
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <AuthProvider>
          <TaskBadgeProvider>
            <StatusBar style="dark" />
            <ChatProvider>
              <RootStack />
            </ChatProvider>
          </TaskBadgeProvider>
        </AuthProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
}
