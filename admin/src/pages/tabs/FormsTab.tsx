import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type FormSummary } from '../../api';
import { useConfirm } from '../../components/confirm';

const SOURCE_LABEL: Record<FormSummary['source'], string> = {
  base: '內建共用',
  tenant: '租戶自建',
  override: '覆寫內建',
};

export default function FormsTab({
  tenantId,
  onError,
  readonly = false,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
  /** 唯讀：可開啟設計器檢視（設計器本身也是唯讀），不能新增或刪除 */
  readonly?: boolean;
}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
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
    const ok = await confirm({
      title: `刪除表單「${forms?.find((f) => f.formId === formId)?.title ?? formId}」？`,
      message: '各角色中此表單的授權會一併撤銷；若有內建同名表單，會自動回退顯示內建版本。',
    });
    if (!ok) return;
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
        {!readonly && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => navigate(`/tenants/${tenantId}/forms/__new__/design`)}
          >
            ＋表單
          </button>
        )}
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
              <div className="row-sub mono">{f.formId}</div>
            </div>
            <div className="row-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate(`/tenants/${tenantId}/forms/${f.formId}/design`)}
              >
                {readonly ? '檢視' : f.source === 'base' ? '以此建立' : '設計'}
              </button>
              {f.editable && !readonly && (
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
