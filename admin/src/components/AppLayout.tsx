import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { applyTheme, getTheme, type Theme } from '../theme';
import { IconLogout, IconTenants } from './icons';
import pkg from '../../package.json';

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
  const { logout } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const onTenants =
    (loc.pathname === '/' || loc.pathname.startsWith('/tenants')) && loc.pathname !== '/skills';
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme());

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  const go = (path: string) => {
    navigate(path);
    setNavOpen(false); // 手機抽屜：導頁後自動收起
  };

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      {/* 手機側邊欄抽屜遮罩 */}
      <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden />

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="/hy_logo.png" alt="凌網資訊" />
          </div>
          <div>
            <div className="brand-name">OA Agent</div>
            <div className="brand-sub">管理後台</div>
          </div>
        </div>

        <div className="nav-label">營運</div>
        <nav className="nav">
          <div
            className={`nav-item${onTenants ? ' active' : ''}`}
            onClick={() => go('/')}
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
            className={`nav-item${loc.pathname === '/skills' ? ' active' : ''}`}
            onClick={() => go('/skills')}
            role="button"
            tabIndex={0}
          >
            <IconTenants className="nav-ico" />
            Skill Library
          </div>
        </nav>

        <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="切換深淺色">
          <span aria-hidden>{theme === 'dark' ? '☀' : '☾'}</span>
          {theme === 'dark' ? '淺色模式' : '深色模式'}
        </button>

        <div className="sidebar-foot">
          OA Agent 多租戶控制台
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
              <span className="avatar">A</span>
              管理員
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              <IconLogout />
              登出
            </button>
          </div>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
