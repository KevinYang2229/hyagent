import { useState } from 'react';
import type { OASchema, PolicySchema, WorkflowSchema } from '@hyagent/shared';
import type { DraftForm } from './model';

/**
 * 進階層編輯器：workflow（簽核關卡）、oa（送出映射）、agent（確認話術）、policy（JSON）。
 * 補齊完整 8 層；policy 較少用、結構深，提供 JSON 編輯後備。
 */
type AdvTab = 'workflow' | 'oa' | 'agent' | 'policy';

export default function AdvancedPanel({
  draft,
  setDraft,
}: {
  draft: DraftForm;
  setDraft: (fn: (d: DraftForm) => DraftForm) => void;
}) {
  const [tab, setTab] = useState<AdvTab>('workflow');
  const fieldKeys = draft.fields.map((f) => f.key);

  return (
    <div className="card advanced-card">
      <h4>⑥ 進階設定</h4>
      <p className="block-desc">非必填。設定簽核關卡、送出到 OA 的欄位映射、對話確認話術，以及工時政策。</p>
      <div className="tabs adv-tabs">
        {(['workflow', 'oa', 'agent', 'policy'] as AdvTab[]).map((t) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t === 'workflow' ? '簽核' : t === 'oa' ? 'OA 送出' : t === 'agent' ? '對話' : '工時政策'}
          </button>
        ))}
      </div>

      {tab === 'workflow' && <WorkflowEditor draft={draft} setDraft={setDraft} />}
      {tab === 'oa' && <OAEditor draft={draft} setDraft={setDraft} fieldKeys={fieldKeys} />}
      {tab === 'agent' && <AgentEditor draft={draft} setDraft={setDraft} />}
      {tab === 'policy' && <PolicyEditor draft={draft} setDraft={setDraft} />}
    </div>
  );
}

function WorkflowEditor({ draft, setDraft }: { draft: DraftForm; setDraft: (fn: (d: DraftForm) => DraftForm) => void }) {
  const steps = draft.workflow?.steps ?? [];
  const update = (next: WorkflowSchema['steps']) =>
    setDraft((d) => ({ ...d, workflow: next.length ? { steps: next } : undefined }));

  return (
    <div className="adv-body">
      <p className="adv-hint">簽核關卡（依序）。留空代表此表單無簽核流程。</p>
      {steps.map((s, i) => (
        <div className="adv-row" key={i}>
          <input
            className="input"
            placeholder="類型 (manager/hr…)"
            value={s.type}
            onChange={(e) => update(steps.map((x, n) => (n === i ? { ...x, type: e.target.value } : x)))}
          />
          <input
            className="input"
            placeholder="顯示名稱"
            value={s.name ?? ''}
            onChange={(e) => update(steps.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => update(steps.filter((_, n) => n !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => update([...steps, { type: 'manager', name: '主管審核' }])}>
        ＋ 新增關卡
      </button>
    </div>
  );
}

function OAEditor({
  draft,
  setDraft,
  fieldKeys,
}: {
  draft: DraftForm;
  setDraft: (fn: (d: DraftForm) => DraftForm) => void;
  fieldKeys: string[];
}) {
  const oa = draft.oa;
  const sources = [...fieldKeys, 'userId', 'hours', 'region'];

  function patchOA(patch: Partial<OASchema>) {
    setDraft((d) => {
      const base: OASchema = d.oa ?? {
        endpoint: '',
        request: { fieldMap: {} },
        response: { idField: 'requestId', statusField: 'status' },
      };
      return { ...d, oa: { ...base, ...patch } };
    });
  }

  if (!oa) {
    return (
      <div className="adv-body">
        <p className="adv-hint">此表單尚未設定 OA 送出映射（不會真的送進 OA）。</p>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() =>
            patchOA({ endpoint: '/api/forms', request: { fieldMap: {} }, response: { idField: 'requestId', statusField: 'status' } })
          }
        >
          ＋ 啟用 OA 送出
        </button>
      </div>
    );
  }

  const fieldMap = oa.request.fieldMap;
  const entries = Object.entries(fieldMap);

  return (
    <div className="adv-body">
      <label className="adv-stack">
        <span>端點 endpoint</span>
        <input className="input" value={oa.endpoint} placeholder="/api/leave-requests" onChange={(e) => patchOA({ endpoint: e.target.value })} />
      </label>

      <span className="adv-subtitle">欄位映射（來源 → OA 欄位）</span>
      {entries.map(([src, dest], i) => (
        <div className="adv-row" key={i}>
          <select
            className="input"
            value={src}
            onChange={(e) => {
              const next = { ...fieldMap };
              delete next[src];
              next[e.target.value] = dest;
              patchOA({ request: { ...oa.request, fieldMap: next } });
            }}
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={dest}
            placeholder="OA 欄位名"
            onChange={(e) => patchOA({ request: { ...oa.request, fieldMap: { ...fieldMap, [src]: e.target.value } } })}
          />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              const next = { ...fieldMap };
              delete next[src];
              patchOA({ request: { ...oa.request, fieldMap: next } });
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => {
          const unused = sources.find((s) => !(s in fieldMap)) ?? sources[0];
          patchOA({ request: { ...oa.request, fieldMap: { ...fieldMap, [unused]: unused } } });
        }}
      >
        ＋ 新增映射
      </button>

      <div className="adv-row">
        <label className="adv-stack">
          <span>回應 idField</span>
          <input className="input" value={oa.response.idField} onChange={(e) => patchOA({ response: { ...oa.response, idField: e.target.value } })} />
        </label>
        <label className="adv-stack">
          <span>回應 statusField</span>
          <input className="input" value={oa.response.statusField ?? ''} onChange={(e) => patchOA({ response: { ...oa.response, statusField: e.target.value } })} />
        </label>
      </div>
      <button className="btn btn-danger btn-sm" onClick={() => setDraft((d) => ({ ...d, oa: undefined }))}>
        移除 OA 設定
      </button>
    </div>
  );
}

function AgentEditor({ draft, setDraft }: { draft: DraftForm; setDraft: (fn: (d: DraftForm) => DraftForm) => void }) {
  return (
    <div className="adv-body">
      <label className="adv-stack">
        <span>確認話術範本（confirmationTemplate，可用 {'{欄位名}'}）</span>
        <textarea
          className="input"
          rows={3}
          value={draft.confirmationTemplate ?? ''}
          placeholder="請確認：{leaveType}，{startDate} 至 {endDate}，事由：{reason}。回覆「確認」即送出。"
          onChange={(e) => setDraft((d) => ({ ...d, confirmationTemplate: e.target.value || undefined }))}
        />
      </label>
      <label className="adv-stack">
        <span>使用者語句範例（每行一句）</span>
        <textarea
          className="input"
          rows={3}
          value={draft.examples.join('\n')}
          placeholder={'我要請病假\n我下週一要請特休'}
          onChange={(e) =>
            setDraft((d) => ({ ...d, examples: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }))
          }
        />
      </label>
    </div>
  );
}

function PolicyEditor({ draft, setDraft }: { draft: DraftForm; setDraft: (fn: (d: DraftForm) => DraftForm) => void }) {
  const [text, setText] = useState(() => (draft.policy ? JSON.stringify(draft.policy, null, 2) : ''));
  const [parseErr, setParseErr] = useState<string | null>(null);

  function apply(v: string) {
    setText(v);
    if (!v.trim()) {
      setParseErr(null);
      setDraft((d) => ({ ...d, policy: undefined }));
      return;
    }
    try {
      const parsed = JSON.parse(v) as PolicySchema;
      setParseErr(null);
      setDraft((d) => ({ ...d, policy: parsed }));
    } catch (e) {
      setParseErr((e as Error).message);
    }
  }

  return (
    <div className="adv-body">
      <p className="adv-hint">工時政策（僅請假類需要）。JSON 編輯，含 default.workDay / regions / holidays。</p>
      <textarea className="input mono" rows={8} value={text} onChange={(e) => apply(e.target.value)} />
      {parseErr && <span className="adv-err">JSON 解析錯誤：{parseErr}</span>}
    </div>
  );
}
