/**
 * Jest 設定（ts-jest，transpile-only）。
 *
 * - moduleNameMapper：對應 `@/` 別名與 workspace 套件 `@hyagent/shared`（指向其 TS 原始碼）。
 * - ts-jest 覆寫 module=CommonJS：原始碼 tsconfig 為 NodeNext，CJS 測試環境下覆寫以免要求副檔名。
 * - isolatedModules：逐檔轉譯、不做跨檔型別檢查（型別由 `npm run typecheck` 把關），測試啟動更快。
 * - setupFiles：在任何模組載入 config/env 前補測試環境變數，避免 env 在缺 key 時 process.exit。
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@hyagent/shared$': '<rootDir>/../shared/src/index.ts',
  },
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node',
          esModuleInterop: true,
          verbatimModuleSyntax: false,
          isolatedModules: true,
        },
      },
    ],
  },
};
