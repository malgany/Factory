import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [
    {
      name: 'desktop-1280',
      testIgnore: /visual\.spec\.ts/,
      use: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
    },
    {
      name: 'desktop-hidpi',
      testMatch: /visual\.spec\.ts/,
      use: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
  },
});
