/**
 * ESLint flat config（ESLint v9）— monorepo 統一設定。
 *
 * 分區套用：
 *   - server / shared / sdk → Node 環境，純 TS 規則
 *   - client / ui / admin   → Browser 環境，TS + React（hooks / fast-refresh）規則
 *
 * 非型別感知（不需 parserOptions.project），保持快速；型別正確性交給各 workspace 的 `typecheck`。
 * 規則 = @eslint/js recommended + typescript-eslint recommended，最後以 prettier 關閉格式衝突規則。
 * 一鍵掃全 repo：`npm run lint`（根目錄）。
 */
const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const reactHooks = require('eslint-plugin-react-hooks');
const reactRefresh = require('eslint-plugin-react-refresh').default;
const prettier = require('eslint-config-prettier');
const globals = require('globals');

/** server / shared / sdk / client / ui / admin 共用的 TS 基底規則 */
const tsBaseRules = {
  ...js.configs.recommended.rules,
  ...tsPlugin.configs.recommended.rules,
  // no-undef 由 TS 編譯器負責，避免對型別/全域誤報
  'no-undef': 'off',
  // 基礎版看不懂 TS function overload，換用認得 overload 的 TS 版
  'no-redeclare': 'off',
  '@typescript-eslint/no-redeclare': 'error',
  // 允許以 _ 前綴標示刻意未使用的參數/變數
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
};

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.cjs',
      '**/*.config.ts',
      // 非主應用程式碼：示範專案、文件
      'presale/**',
      'docs/**',
    ],
  },

  // ---- 後端 / 共用 / SDK：Node 環境 ----
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'sdk/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.jest },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: tsBaseRules,
  },

  // ---- 後端測試：允許 jest.resetModules() + require() 重載模組的寫法 ----
  {
    files: ['server/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ---- 前端：Browser + React（client / ui / admin）----
  {
    files: ['client/**/*.{ts,tsx}', 'ui/**/*.{ts,tsx}', 'admin/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...tsBaseRules,
      // React 核心兩規則（穩定基線；不採 v7 recommended-latest 的實驗規則）
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  prettier,
];
