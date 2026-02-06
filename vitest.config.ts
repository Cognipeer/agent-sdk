import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'examples'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        lines: 30,
        functions: 30,
        branches: 20,
        statements: 30,
      },
    },
    testTimeout: 30000,
    hookTimeout: 10000,
    reporters: ['verbose'],
    // Vitest 4.x: pool options are now top-level
    pool: 'forks',
    singleFork: true,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
