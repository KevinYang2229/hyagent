import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setErr(null);
    setBusy(true);
    try {
      await login(password);
      navigate("/", { replace: true });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      {/* 裝飾：漂浮光暈球（純視覺） */}
      <div className="login-orbs" aria-hidden>
        <span className="login-orb orb-1" />
        <span className="login-orb orb-2" />
        <span className="login-orb orb-3" />
      </div>

      <div className="login-card">
        <div className="login-brand">
          <div
            className="brand-mark"
            style={{ width: 44, height: 44, borderRadius: 13 }}
          >
            <img src="/hy_logo.png" alt="凌網資訊" />
          </div>
          <div>
            <div className="login-title">管理後台</div>
            <div className="login-sub">HyAgent 多租戶控制台</div>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="pw">
              管理密碼
            </label>
            <input
              id="pw"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="請輸入管理密碼"
              autoFocus
            />
          </div>
          {err && <p className="login-err">{err}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "登入中…" : "登入控制台"}
          </button>
        </form>

        <div className="login-foot">受 ADMIN_PASSWORD 保護 · 僅限管理員</div>
      </div>
    </div>
  );
}
