import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.mjs', 'src/**/*.test.js'],
    environment: 'node',
    testTimeout: 30000
  }
});
