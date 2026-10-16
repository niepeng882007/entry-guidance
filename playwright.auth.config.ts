import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './test/auth/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4180', trace: 'retain-on-failure' },
  webServer: {
    command: 'node test/auth/browser-server.ts',
    url: 'http://127.0.0.1:4180/login',
    timeout: 60000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } },
  ],
});
