const pad = (n: number) => String(n).padStart(2, '0');

/** 建立時間（裝置時區）：今天顯示「今天 HH:mm」，其他日「MM/DD HH:mm」 */
export function formatCreatedAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `今天 ${time}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

export function formatArrival(date: string): string {
  const [, m, d] = date.split('-');
  return `${m}/${d}`;
}
