import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __RELEASE_VERSION__: JSON.stringify('0.2.0'), 'import.meta.env.WXT_FIREBASE_EMULATORS': JSON.stringify('1') },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
