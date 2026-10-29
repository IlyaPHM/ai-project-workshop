import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { DEEPSEEK_API_KEY: 'test-only-not-real', STUDENT_CODES_JSON: '{}' } } })],
  test: { testTimeout: 15_000 },
});
