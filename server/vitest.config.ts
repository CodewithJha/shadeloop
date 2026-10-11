import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'memory',
      MONGODB_DB: 'shadeloop_test',
      LOG_LEVEL: 'silent',
      AI_PROVIDER: 'ollama',
      OLLAMA_URL: 'http://ollama.test:11434',
      AI_MAX_RETRIES: '1',
      AI_TIMEOUT_MS: '2000',
      DISCOVERY_MODE: 'live',
      RATE_LIMIT_PER_MIN: '10000',
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
