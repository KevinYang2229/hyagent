/** 登入狀態離開 signedIn（登出、換人）時清掉使用者相關的暫存狀態。沒有 AuthProvider（測試）時略過。 */
import { useEffect } from 'react';
import { useAuth } from './AuthProvider';

export function useAuthStatusOptional(): string | undefined {
  try {
    return useAuth().status;
  } catch {
    return undefined;
  }
}

export function useSignedOutReset(reset: () => void): void {
  const status = useAuthStatusOptional();
  useEffect(() => {
    if (status !== undefined && status !== 'signedIn') reset();
  }, [status, reset]);
}
