import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.test.js',
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
  },
  projects: [
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
      },
    },
  ],
});
