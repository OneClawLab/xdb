import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 60000,
    fileParallelism: false,
    include: ['vitest/**/*-manual.test.ts'],
  },
});
