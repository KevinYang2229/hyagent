/**
 * 簽核關卡狀態計算（form-agnostic）。
 *
 * 由各表單 service（請假／外出登記…）與對話查詢共用：依 workflow 關卡定義與送出時間，
 * 推算每關 approved/current/pending 狀態。Demo 以時間自動推進；真串接時改由 OA 連接器查詢。
 */
import type { ApprovalStep } from '@hyagent/shared';
import type { Definition } from './form.types';

// Demo 模擬：送出後每經過此時間就自動核准一關（真實串接時改由 OA 連接器查詢狀態）
const DEMO_STEP_MS = 15_000;

/** 取 workflow 關卡定義（名稱／類型）；無 workflow 回空陣列 */
export function stepDefs(def: Definition): Array<Pick<ApprovalStep, 'name' | 'type'>> {
  return (def.workflow?.steps ?? []).map((s) => ({ name: s.name ?? s.type, type: s.type }));
}

/**
 * 依送出時間計算各關卡狀態（Demo：時間到自動核准）。
 * 已過 N 關為 approved，下一關為 current，其餘 pending；全部過則無 current（流程完成）。
 */
export function computeApprovals(
  steps: Array<Pick<ApprovalStep, 'name' | 'type'>>,
  submittedAt: string,
): ApprovalStep[] {
  const elapsed = Date.now() - Date.parse(submittedAt);
  const approved = Math.max(0, Math.min(steps.length, Math.floor(elapsed / DEMO_STEP_MS)));
  return steps.map((s, i) => ({
    ...s,
    status: i < approved ? 'approved' : i === approved ? 'current' : 'pending',
  }));
}

/**
 * 查詢目前簽核進度：依既有關卡（名稱/類型）與送出時間重新計算狀態。
 * 供 GET 對話時即時反映目前流程審核狀態。
 */
export function refreshApprovals(approvals: ApprovalStep[], submittedAt?: string): ApprovalStep[] {
  if (!submittedAt || approvals.length === 0) return approvals;
  return computeApprovals(
    approvals.map((a) => ({ name: a.name, type: a.type })),
    submittedAt,
  );
}
