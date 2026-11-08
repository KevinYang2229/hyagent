/** 卡片標題旁的「未儲存」標示 */
export default function UnsavedBadge({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return <span className="badge badge-warn" style={{ marginLeft: 8 }} role="status">未儲存</span>;
}
