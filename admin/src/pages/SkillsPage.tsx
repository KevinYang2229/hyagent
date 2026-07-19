import { useEffect, useState } from 'react';
import AppLayout from '../components/AppLayout';
import { api, UnauthorizedError, type SkillLibraryView } from '../api';
import { useAuth } from '../auth';
import { useNavigate } from 'react-router-dom';

/**
 * Skill Library（唯讀）：平台所有 skill 的正式描述——名稱、觸發意圖、所需 scope、
 * 各租戶啟用狀態。資料來源為 server 的 serviceRegistry.describe（Skill 契約單一來源）。
 */
export default function SkillsPage() {
  const [view, setView] = useState<SkillLibraryView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void api
      .listSkills()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((e: unknown) => {
        if (e instanceof UnauthorizedError) {
          logout();
          navigate('/login');
          return;
        }
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [logout, navigate]);

  return (
    <AppLayout crumb="平台" title="Skill Library">
      {err && <div className="card"><div className="empty">{err}</div></div>}
      {!view && !err && <div className="card"><div className="empty">載入中…</div></div>}
      {view && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">內建 Skill（{view.skills.length}）</div>
                <div className="card-desc">
                  平台能力以 Skill 為單位掛載；租戶可於「權限」與服務開關決定啟用範圍。此頁為唯讀。
                </div>
              </div>
            </div>
          </div>

          {view.skills.map((s) => {
            const disabledBy = view.tenants.filter((t) => t.disabledServices.includes(s.id));
            return (
              <div key={s.id} className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {s.label}
                      <code style={{ fontSize: 12, opacity: 0.7 }}>{s.id}</code>
                      {s.sticky && <span className="badge badge-on">流程擁有者</span>}
                      {s.alwaysEnabled && <span className="badge badge-off">恆啟用</span>}
                    </div>
                    <div className="card-desc">{s.description}</div>
                  </div>
                </div>
                <div className="card-body" style={{ display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13.5 }}>
                    <span style={{ opacity: 0.7 }}>所需 scope：</span>
                    {s.requiredScope ? <code>{s.requiredScope}</code> : '無（恆啟用）'}
                  </div>
                  <div style={{ fontSize: 13.5 }}>
                    <div style={{ opacity: 0.7, marginBottom: 4 }}>觸發意圖（{s.intents.length}）：</div>
                    <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
                      {s.intents.map((i) => (
                        <li key={i.id}>
                          <code style={{ fontSize: 12, marginRight: 6 }}>{i.id}</code>{i.description}
                          {i.keywords.length > 0 && (
                            <span style={{ opacity: 0.6 }}>（關鍵字：{i.keywords.join('、')}）</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {disabledBy.length > 0 && (
                    <div style={{ fontSize: 13.5 }}>
                      <span style={{ opacity: 0.7 }}>停用此 skill 的租戶：</span>
                      {disabledBy.map((t) => t.name).join('、')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}
