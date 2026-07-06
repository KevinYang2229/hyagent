import { useCallback, useEffect, useState } from 'react';
import { Checkbox, useToast } from '@oa-agent/ui';
import { api, type TenantServiceCatalog } from '../../api';

export default function ServicesTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const [cat, setCat] = useState<TenantServiceCatalog | null>(null);
  const [saving, setSaving] = useState(false);
  const [formsOpen, setFormsOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      setCat(await api.getTenantServices(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleService = (id: string) =>
    setCat((c) =>
      c ? { ...c, services: c.services.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) } : c,
    );
  const toggleForm = (formId: string) =>
    setCat((c) =>
      c ? { ...c, forms: c.forms.map((f) => (f.formId === formId ? { ...f, enabled: !f.enabled } : f)) } : c,
    );

  const save = async () => {
    if (!cat) return;
    setSaving(true);
    try {
      await api.updateTenant(tenantId, {
        disabledServices: cat.services.filter((s) => !s.enabled).map((s) => s.id),
        disabledForms: cat.forms.filter((f) => !f.enabled).map((f) => f.formId),
      });
      await load();
      toast.success('已儲存變更');
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  if (!cat)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );
  const noService = cat.services.every((s) => !s.enabled);
  const formEnabled = cat.services.find((s) => s.id === 'form')?.enabled ?? false;
  const noForm = cat.forms.length > 0 && cat.forms.every((f) => !f.enabled);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Agent 服務</div>
          <div className="card-desc">取消勾選即停用該類服務；「填表申請」可再展開控制個別表單。預設全開。</div>
        </div>
      </div>

      <ul className="list">
        {cat.services.map((s) => (
          <li key={s.id} className="row" style={{ display: 'block' }}>
            <div className="row-main" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ cursor: 'pointer' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Checkbox checked={s.enabled} onChange={() => toggleService(s.id)} />
                  <span style={{ fontWeight: 500 }}>{s.label}</span>
                </span>
                <span className="row-sub" style={{ display: 'block', marginLeft: 24 }}>
                  {s.id}
                </span>
              </label>
              {s.id === 'form' && cat.forms.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setFormsOpen((v) => !v)}
                  aria-expanded={formsOpen}
                  style={{ height: 24, padding: '0 8px' }}
                >
                  {formsOpen ? '▾ 收合表單' : `▸ 展開表單（${cat.forms.length}）`}
                </button>
              )}
            </div>

            {/* 填表申請底下展開個別表單子項目（可收合） */}
            {s.id === 'form' && formsOpen && (
              <div style={{ marginLeft: 26, marginTop: 8, opacity: formEnabled ? 1 : 0.5 }}>
                {cat.forms.map((f) => (
                  <label
                    key={f.formId}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}
                  >
                    <Checkbox
                      checked={f.enabled}
                      disabled={!formEnabled}
                      onChange={() => toggleForm(f.formId)}
                    />
                    <span>{f.title}</span>
                    <span className="row-sub" style={{ marginLeft: 4 }}>
                      {f.formId}
                    </span>
                  </label>
                ))}
                {cat.forms.length === 0 && <div className="row-sub">尚無表單。</div>}
                {noForm && <div className="row-sub">⚠️ 已停用全部表單，填表功能將無法選到表單。</div>}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        {noService && (
          <div className="row-sub" style={{ marginBottom: 12 }}>
            ⚠️ 已停用全部服務，此租戶對話將無可用功能。
          </div>
        )}
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          儲存
        </button>
      </div>
    </div>
  );
}
