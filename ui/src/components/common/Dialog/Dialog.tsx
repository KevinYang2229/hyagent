import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Button, { type ButtonVariant } from "../Button/Button";
import "../Modal.css";
import "./Dialog.css";

/** 確認按鈕外觀變體 */
export type DialogConfirmVariant = "primary" | "danger";

export interface DialogProps {
  /** 是否顯示 */
  isOpen: boolean;
  /** 標題 */
  title: ReactNode;
  /** 內容（支援字串或自訂節點） */
  children?: ReactNode;
  /** 確認按鈕文字；未提供使用 i18n common.confirm */
  confirmText?: ReactNode;
  /** 取消按鈕文字；未提供使用 i18n common.cancel */
  cancelText?: ReactNode;
  /** 確認按鈕語意（影響顏色）；預設 primary */
  confirmVariant?: DialogConfirmVariant;
  /** 是否隱藏取消按鈕（純提示用） */
  hideCancel?: boolean;
  /** 點擊取消或關閉時觸發 */
  onClose: () => void;
  /** 點擊確定時觸發 */
  onConfirm?: () => void;
  /** 停用確認按鈕（例如需輸入確認字樣的危險操作）；有設定時確認鈕不自動取得焦點，讓內容裡的輸入框可以先輸入 */
  confirmDisabled?: boolean;
}

/**
 * 通用確認彈窗元件
 * 用於取代 window.confirm，提供統一風格的確認/取消互動
 */
export default function Dialog({
  isOpen,
  title,
  children,
  confirmText,
  cancelText,
  confirmVariant = "primary",
  hideCancel = false,
  onClose,
  onConfirm,
  confirmDisabled,
}: DialogProps) {
  const { t } = useTranslation();

  // ESC 鍵關閉
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleConfirm = () => {
    if (confirmDisabled) return;
    onConfirm?.();
  };

  const confirmBtnVariant: ButtonVariant =
    confirmVariant === "danger" ? "cancel" : "confirm";

  return createPortal(
    <div
      className="modal-overlay active"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      onClick={handleOverlayClick}
    >
      <div className="modal-container hy-dialog">
        <div className="hy-dialog-body">
          <h3 id="dialog-title" className="hy-dialog-title">
            {title}
          </h3>
          {children !== undefined && (
            <div className="hy-dialog-content">{children}</div>
          )}
        </div>
        <div className="hy-dialog-footer">
          {!hideCancel && (
            <Button variant="reset" size="md" onClick={onClose}>
              {cancelText ?? t("common.cancel")}
            </Button>
          )}
          <Button
            // 危險確認不借用 cancel 變體：cancel 的 hover 以 !important 改成白底深字，會蓋掉紅底白字
            variant={confirmVariant === "danger" ? undefined : confirmBtnVariant}
            size="md"
            className={confirmVariant === "danger" ? "hy-dialog-confirm--danger" : ""}
            onClick={handleConfirm}
            disabled={confirmDisabled}
            autoFocus={confirmDisabled === undefined}
          >
            {confirmText ?? t("common.confirm")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
