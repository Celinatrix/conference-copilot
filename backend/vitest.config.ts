import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file boots its own in-memory PGlite (WASM) and runs every migration in beforeAll. On a loaded
    // machine (a build running alongside, a busy CI runner) that once exceeded the 10 s default and skipped a file.
    hookTimeout: 30_000,
  },
});
