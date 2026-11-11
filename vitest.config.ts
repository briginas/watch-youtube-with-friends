import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __RELEASE_VERSION__: JSON.stringify('0.2.0'), 'import.meta.env.WXT_FIREBASE_EMULATORS': JSON.stringify('1') },
  test: {
    include: ['src/**/*.test.ts', 'tests/cloud/**/*.test.ts', 'tests/release/**/*.test.mjs'],
    environment: 'node',
    setupFiles: ['tests/i18n-setup.ts'],
  },
});
