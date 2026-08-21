import { useTranslation } from "react-i18next";
import { Button } from "@hyagent/ui";

/**
 * 登入／連線失敗的整頁錯誤畫面。
 * 取代「靜默掉回帳密登入頁」：SSO 換發失敗、或登入後因金鑰（pk）不正確而被踢出時，
 * 直接說明原因並提供「重試」，避免「跳進聊天室又跳回登入頁」的閃爍。
 */
export default function AuthErrorView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="login-shell">
      <div className="login-card items-center text-center">
        <div className="text-4xl" aria-hidden="true">
          ⚠️
        </div>
        <h1 className="login-title">{t("auth.errorTitle")}</h1>
        <p className="login-sub !mt-0">{message}</p>
        <Button
          variant="confirm"
          size="md"
          type="button"
          onClick={onRetry}
          className="w-full"
        >
          {t("auth.retry")}
        </Button>
      </div>
    </div>
  );
}
