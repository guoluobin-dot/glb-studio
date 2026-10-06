import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只收 vitest 语法的用例。src/**/__tests__/*.test.mjs 是 node:test 写的,
    // vitest 会报 "No test suite found"。它们用 `node --test src/**\/*.test.mjs` 跑。
    include: ['src/**/*.test.ts', 'src/**/*.vitest.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/**', '**/__tests__/**'],
    environment: 'node',
    testTimeout: 30000
  }
});
