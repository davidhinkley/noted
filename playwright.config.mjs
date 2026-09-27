import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:8799',
  },
  webServer: {
    command: 'serve -s . -l 8799',
    url: 'http://127.0.0.1:8799',
    timeout: 15000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: {} },
  ],
  reporter: 'html',
  timeout: 30000,
});
