import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UnauthorizedError } from '../api';
import { useAuth } from '../auth';
import AppLayout from '../components/AppLayout';
import AuditTab from './tabs/AuditTab';

/** 平台稽核紀錄（平台層）：建立／刪除租戶、MCP 服務等。租戶層稽核在各租戶的稽核分頁。 */
export default function AuditPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [err, setErr] = useState<string | null>(null);

  // 穩定參照：AuditTab 以 onError 為 load 的相依，每次 render 換新函式會造成重複載入
  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        logout();
        navigate('/login', { replace: true });
        return;
      }
      setErr(e instanceof Error ? e.message : '發生錯誤');
    },
    [logout, navigate],
  );

  return (
    <AppLayout crumb="平台" title="平台稽核紀錄">
      {err && <div className="card" style={{ marginBottom: 16 }}><div className="card-body form-errors">{err}</div></div>}
      {/* 獨立頁面不必和其他卡片搶空間：捲動區撐到視窗高度 */}
      <AuditTab onError={handleErr} scrollMaxHeight="calc(100vh - 220px)" />
    </AppLayout>
  );
}
