import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Dialog, useToast } from "@hyagent/ui";
import { api, tokenStore } from "../api";
import { useAuth } from "../auth";
import { applyTheme, getTheme, type Theme } from "../theme";
import { IconAudit, IconLogout, IconPlug, IconSkills, IconTenants } from "./icons";
import pkg from "../../package.json";

/** 租戶管理者自行修改密碼；成功後後端會讓舊 token 失效，改存新 token 以維持登入 */
function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    if (!current) return setErr("請輸入目前密碼");
    if (next.length < 10 || next.length > 128) return setErr("新密碼長度需為 10 到 128 個字元");
    if (next !== again) return setErr("兩次輸入的新密碼不一致");
    setErr(null);
    setBusy(true);
    try {
      const { token } = await api.changeMyPassword(current, next);
      tokenStore.set(token);
      toast.success("密碼已更新");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "修改失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      isOpen
      title="修改密碼"
      confirmText={busy ? "儲存中…" : "儲存"}
      confirmDisabled={busy}
      onClose={onClose}
      onConfirm={() => void submit()}
    >
      <label className="field">
        <span className="field-label">目前密碼</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="field-label">新密碼（10 到 128 個字元）</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">再輸入一次新密碼</span>
        <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {err && <p className="login-err">{err}</p>}
    </Dialog>
  );
}

/**
 * 控制台外殼：深色側邊欄 + 頂部列 + 內容區。
 * 各頁傳入麵包屑、標題、右上動作與內容。
 */
export default function AppLayout({
  crumb,
  title,
  actions,
  children,
}: {
  crumb?: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { logout, me, isSuper } = useAuth();
  const [pwOpen, setPwOpen] = useState(false);
  const navigate = useNavigate();
  const loc = useLocation();
  const onTenants = loc.pathname === "/" || loc.pathname.startsWith("/tenants");
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme());

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  const go = (path: string) => {
    navigate(path);
    setNavOpen(false); // 手機抽屜：導頁後自動收起
  };

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      {/* 手機側邊欄抽屜遮罩 */}
      <div
        className="nav-backdrop"
        onClick={() => setNavOpen(false)}
        aria-hidden
      />

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="/hy_logo.png" alt="凌網資訊" />
          </div>
          <div>
            <div className="brand-name">HyAgent</div>
            <div className="brand-sub">管理後台</div>
          </div>
        </div>

        {isSuper && (
          <>
        <div className="nav-label">營運</div>
        <nav className="nav">
          <div
            className={`nav-item${onTenants ? " active" : ""}`}
            onClick={() => go("/")}
            role="button"
            tabIndex={0}
          >
            <IconTenants className="nav-ico" />
            租戶
          </div>
        </nav>

        <div className="nav-label">平台</div>
        <nav className="nav">
          <div
            className={`nav-item${loc.pathname === "/skills" ? " active" : ""}`}
            onClick={() => go("/skills")}
            role="button"
            tabIndex={0}
          >
            <IconSkills className="nav-ico" />
            Skill Library
          </div>
          <div
            className={`nav-item${loc.pathname === "/mcp-servers" ? " active" : ""}`}
            onClick={() => go("/mcp-servers")}
            role="button"
            tabIndex={0}
          >
            <IconPlug className="nav-ico" />
            MCP 服務
          </div>
          <div
            className={`nav-item${loc.pathname === "/audit" ? " active" : ""}`}
            onClick={() => go("/audit")}
            role="button"
            tabIndex={0}
          >
            <IconAudit className="nav-ico" />
            平台稽核紀錄
          </div>
        </nav>
          </>
        )}

        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="切換深淺色"
        >
          <span aria-hidden>{theme === "dark" ? "☀" : "☾"}</span>
          {theme === "dark" ? "淺色模式" : "深色模式"}
        </button>

        <div className="sidebar-foot">
          HyAgent 多租戶控制台
          <br />
          <code>v{pkg.version}</code>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="nav-toggle"
              onClick={() => setNavOpen(true)}
              aria-label="開啟選單"
            >
              ☰
            </button>
            <div className="topbar-title">
              {crumb && <span className="topbar-crumb">{crumb}</span>}
              <span className="topbar-h">{title}</span>
            </div>
          </div>
          <div className="topbar-actions">
            {actions}
            <div className="user-chip">
              <span className="avatar">{me?.kind === "tenant-admin" ? (me.displayName || me.username).slice(0, 1) : "A"}</span>
              {me?.kind === "tenant-admin" ? me.displayName || me.username : "管理員"}
            </div>
            {me?.kind === "tenant-admin" && (
              <button className="btn btn-ghost btn-sm" onClick={() => setPwOpen(true)}>
                修改密碼
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              <IconLogout />
              登出
            </button>
          </div>
        </header>

        <main className="content">{children}</main>
      </div>
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}
    </div>
  );
}
