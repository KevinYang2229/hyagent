import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./Toast.css";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  /** 顯示訊息 */
  message: ReactNode;
  variant?: ToastVariant;
  /**
   * 自動關閉毫秒數；傳 0 或 null 則不自動關閉（需手動關閉）。
   * 未指定時：success / info 用 3500，warning / error 用 5000。
   */
  duration?: number | null;
}

/** 便捷方法的選項（不含 message / variant，由方法本身帶入） */
type ShortcutOptions = Omit<ToastOptions, "message" | "variant">;

export interface ToastApi {
  /** 完整設定顯示一則 toast；回傳其 id（可用於 dismiss） */
  show: (opts: ToastOptions) => string;
  success: (message: ReactNode, opts?: ShortcutOptions) => string;
  error: (message: ReactNode, opts?: ShortcutOptions) => string;
  info: (message: ReactNode, opts?: ShortcutOptions) => string;
  warning: (message: ReactNode, opts?: ShortcutOptions) => string;
  /** 立即關閉指定 toast */
  dismiss: (id: string) => void;
}

interface ToastEntry extends ToastOptions {
  id: string;
  variant: ToastVariant;
  /** 離場動畫中（等動畫結束才真正移除） */
  leaving: boolean;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3500,
  info: 3500,
  warning: 5000,
  error: 5000,
};

const LEAVE_MS = 200; // 對應 Toast.css 的離場動畫長度

let seq = 0;
const nextId = (): string => `toast-${Date.now()}-${seq++}`;

/**
 * Toast 通知的 Provider。包在應用根部，內部任何元件即可用 useToast() 顯示提示。
 * 提示以固定右上角堆疊呈現，預設自動關閉，也可手動關閉。
 */
export function ToastProvider({
  children,
  closeLabel = "關閉",
}: {
  children: ReactNode;
  /** 關閉按鈕 aria-label，預設「關閉」 */
  closeLabel?: string;
}) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const remove = useCallback(
    (id: string) => {
      clearTimer(id);
      setItems((list) => list.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const dismiss = useCallback(
    (id: string) => {
      // 先標記離場動畫，動畫結束後才自 DOM 移除
      setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      clearTimer(id);
      timers.current.set(
        id,
        setTimeout(() => remove(id), LEAVE_MS),
      );
    },
    [clearTimer, remove],
  );

  const show = useCallback(
    (opts: ToastOptions): string => {
      const id = nextId();
      const variant = opts.variant ?? "info";
      const duration =
        opts.duration === undefined ? DEFAULT_DURATION[variant] : opts.duration;
      setItems((list) => [...list, { ...opts, id, variant, leaving: false }]);
      if (duration) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, o) => show({ ...o, message, variant: "success" }),
      error: (message, o) => show({ ...o, message, variant: "error" }),
      info: (message, o) => show({ ...o, message, variant: "info" }),
      warning: (message, o) => show({ ...o, message, variant: "warning" }),
      dismiss,
    }),
    [show, dismiss],
  );

  // 卸載時清掉所有計時器，避免對已卸載元件 setState
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="region" aria-live="polite" aria-label="通知">
        {items.map((t) => (
          <ToastRow
            key={t.id}
            entry={t}
            closeLabel={closeLabel}
            onClose={() => dismiss(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 取得 toast API；必須在 <ToastProvider> 內使用 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必須在 <ToastProvider> 內使用");
  return ctx;
}

// ---- 內部呈現 ----

function ToastRow({
  entry,
  closeLabel,
  onClose,
}: {
  entry: ToastEntry;
  closeLabel: string;
  onClose: () => void;
}) {
  // 外層 .toast-item 負責進/離場與堆疊高度的絲滑收合；內層 .toast 為卡片本體。
  return (
    <div className={`toast-item${entry.leaving ? " is-leaving" : ""}`}>
      <div className="toast-item-inner">
        <div
          className={`toast toast-${entry.variant}`}
          role={entry.variant === "error" ? "alert" : "status"}
        >
          <span className="toast-icon" aria-hidden="true">
            {VARIANT_ICON[entry.variant]}
          </span>
          <span className="toast-msg">{entry.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

// 內建 SVG 圖示（不依賴任何 icon font，讓元件在各 app 皆可獨立運作）
const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const VARIANT_ICON: Record<ToastVariant, ReactNode> = {
  success: (
    <svg {...iconProps}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  error: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
  info: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
  warning: (
    <svg {...iconProps}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

function XIcon() {
  return (
    <svg {...iconProps}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default ToastProvider;
