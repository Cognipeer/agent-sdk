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
      // Gradual ratchet: kept ~4-5pt below current actuals (stmts ~72, branch
      // ~60, funcs ~79, lines ~75) so the floor enforces real coverage without
      // being brittle. Remaining headroom is mostly in `src/providers`
      // streaming/request-build paths (per-provider buildRequestBody, Vertex/
      // Bedrock completeStream) — raise further as those gain tests.
      thresholds: {
        lines: 70,
        functions: 75,
        branches: 56,
        statements: 68,
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
