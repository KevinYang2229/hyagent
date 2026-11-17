import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const FONT_MIN = 80;
export const FONT_MAX = 140;
const FONT_STEP = 10;

type Theme = 'light' | 'dark';

// ---- 線條圖示（避免使用 emoji）----
type IconProps = { className?: string };

const GearIcon = ({ className }: IconProps) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const SunIcon = ({ className }: IconProps) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const MoonIcon = ({ className }: IconProps) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

interface Props {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  language: string;
  onLanguageChange: (lng: string) => void;
  fontScale: number;
  onFontScaleChange: (n: number) => void;
  /** 未提供（訪客）時不顯示登出：訪客沒有可登出的帳號 */
  onLogout?: () => void;
}

/** 齒輪設定選單：外觀模式 / 系統字級 / 切換語言 / 登出 */
export default function SettingsMenu({
  theme,
  onThemeChange,
  language,
  onLanguageChange,
  fontScale,
  onFontScaleChange,
  onLogout,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 點選單外 / 按 Esc 關閉
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isDark = theme === 'dark';
  const clamp = (n: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, n));

  return (
    <div className="settings" ref={ref}>
      <button
        type="button"
        className={`settings-trigger${open ? ' active' : ''}`}
        aria-label={t('settings.title')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>

      {open && (
        <div className="settings-panel" role="menu">
          {/* 外觀模式 */}
          <section className="settings-section">
            <p className="settings-label">{t('settings.appearance')}</p>
            <button
              type="button"
              className={`settings-switch${isDark ? ' dark' : ''}`}
              role="switch"
              aria-checked={isDark}
              aria-label={t('settings.appearance')}
              onClick={() => onThemeChange(isDark ? 'light' : 'dark')}
            >
              <SunIcon className="settings-switch-icon text-amber-500" />
              <span className="settings-switch-track">
                <span className="settings-switch-knob" />
              </span>
              <MoonIcon className="settings-switch-icon text-sky-400" />
            </button>
          </section>

          <div className="settings-divider" />

          {/* 系統字級 */}
          <section className="settings-section">
            <p className="settings-label">{t('settings.fontSize')}</p>
            <div className="settings-stepper">
              <button
                type="button"
                className="settings-step"
                aria-label={t('settings.fontSmaller')}
                disabled={fontScale <= FONT_MIN}
                onClick={() => onFontScaleChange(clamp(fontScale - FONT_STEP))}
              >
                −
              </button>
              <span className="settings-step-value">{fontScale}%</span>
              <button
                type="button"
                className="settings-step"
                aria-label={t('settings.fontLarger')}
                disabled={fontScale >= FONT_MAX}
                onClick={() => onFontScaleChange(clamp(fontScale + FONT_STEP))}
              >
                +
              </button>
            </div>
          </section>

          <div className="settings-divider" />

          {/* 切換語言 */}
          <section className="settings-section">
            <p className="settings-label">{t('settings.language')}</p>
            <div className="settings-langs">
              <button
                type="button"
                className={`settings-lang${language === 'zh-Hant' ? ' active' : ''}`}
                onClick={() => onLanguageChange('zh-Hant')}
              >
                繁體中文
              </button>
              <button
                type="button"
                className={`settings-lang${language === 'en' ? ' active' : ''}`}
                onClick={() => onLanguageChange('en')}
              >
                English
              </button>
            </div>
          </section>

          {onLogout && <div className="settings-divider" />}

          {/* 登出 */}
          {onLogout && (
          <button
            type="button"
            className="settings-logout"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t('auth.logout')}
          </button>
          )}
        </div>
      )}
    </div>
  );
}
