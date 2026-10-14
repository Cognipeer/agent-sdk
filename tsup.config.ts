import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
  external: [],
  // The rules JSON is bundled into the code AND shipped as a file, so hosts
  // (the console) can read it as "@cognipeer/agent-sdk/model-rules.json".
  onSuccess: async () => {
    copyFileSync('src/models/model-rules.json', 'dist/model-rules.json');
  },
  outExtension({ format }) {
    return {
      js: format === 'cjs' ? '.cjs' : '.mjs',
    };
  },
});
