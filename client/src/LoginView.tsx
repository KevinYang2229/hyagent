import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@hyagent/ui";
import { auth, type Applicant } from "./api";

/** 登入頁：帳密 → 取得 access/refresh token 與使用者資料 */
export default function LoginView({
  onLogin,
  assistantName,
}: {
  onLogin: (user: Applicant) => void;
  /** 顯示用 AI 名稱（租戶自訂 / fallback 預設）；用於副標題 */
  assistantName: string;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("hyweb");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setErr(null);
    setBusy(true);
    try {
      const user = await auth.login(username.trim(), password);
      onLogin(user);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">{t("app.title")}</h1>
        <p className="login-sub">
          {t("auth.subtitle", { name: assistantName })}
        </p>

        <label className="login-field">
          <span className="login-label">{t("auth.username")}</span>
          <Input
            value={username}
            autoFocus
            placeholder="hyweb"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="login-field">
          <span className="login-label">{t("auth.password")}</span>
          <Input
            type="password"
            value={password}
            placeholder="••••••"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {err && <p className="login-error">⚠️ {err}</p>}

        <Button
          variant="confirm"
          size="md"
          type="submit"
          disabled={busy}
          className="w-full"
        >
          {busy ? t("auth.loggingIn") : t("auth.login")}
        </Button>

        {/* <p className="login-hint">{t("auth.devHint")}</p> */}
      </form>
    </div>
  );
}
