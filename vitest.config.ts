import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 10000,
    fileParallelism: false,
    include: ['vitest/**/*.test.ts'],
    exclude: ['vitest/**/*-manual.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.config.ts',
      ],
    },
  },
});
