import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type FormSummary } from '../../api';

const SOURCE_LABEL: Record<FormSummary['source'], string> = {
  base: '內建共用',
  tenant: '租戶自建',
  override: '覆寫內建',
};

export default function FormsTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const navigate = useNavigate();
  // 從表單設計器新建後帶回：新表單尚未開放給任何人，提醒到權限頁加進角色
  const [searchParams] = useSearchParams();
  const created = searchParams.get('created');
  const [forms, setForms] = useState<FormSummary[] | null>(null);

  const reload = useCallback(async () => {
    try {
      setForms(await api.listForms(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(formId: string) {
    if (!confirm(`確定刪除表單「${formId}」？（內建同名表單會自動回退顯示）`)) return;
    try {
      await api.deleteForm(tenantId, formId);
      await reload();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">表單</div>
          <div className="card-desc">拖曳設計表單，存檔後即時生效；內建表單可「以此建立」為租戶版。</div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => navigate(`/tenants/${tenantId}/forms/__new__/design`)}
        >
          ＋表單
        </button>
      </div>

      {created && (
        <div className="card-body">
          <div className="banner" role="status">
            已建立表單「{forms?.find((f) => f.formId === created)?.title ?? created}」。新表單尚未開放給任何人（包含網站訪客），
            請到「權限」把它加進角色（例如「通用服務」），並確認角色含「填表申請」。
            <Link className="btn btn-sm" to="?tab=permissions" style={{ marginLeft: 8 }}>前往權限</Link>
          </div>
        </div>
      )}
      <ul className="list">
        {forms === null && <li className="empty">載入中…</li>}
        {forms?.length === 0 && <li className="empty">尚無表單</li>}
        {forms?.map((f) => (
          <li key={f.formId} className="row">
            <div className="row-main">
              <div className="row-title">
                <span className={`badge ${f.source === 'base' ? 'badge-off' : 'badge-on'}`}>
                  {SOURCE_LABEL[f.source]}
                </span>
                <span>{f.title}</span>
              </div>
              <div className="row-sub">{f.formId}</div>
            </div>
            <div className="row-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate(`/tenants/${tenantId}/forms/${f.formId}/design`)}
              >
                {f.source === 'base' ? '以此建立' : '設計'}
              </button>
              {f.editable && (
                <button className="btn btn-danger btn-sm" onClick={() => remove(f.formId)}>
                  刪除
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
