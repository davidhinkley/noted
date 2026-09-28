import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:8799',
  },
  // Never reuse a server. A lingering `serve` from an earlier session hands the
  // browser files that do not match disk, and a green suite against stale code
  // is the exact false confidence D15 exists to end. If the port is taken the
  // run fails here, loudly, instead of testing the wrong app. The globalSetup
  // below then byte-compares what the fresh server serves against disk, so a
  // stale cache layer fails the run rather than passing it.
  globalSetup: './tests/global-setup.mjs',
  webServer: {
    command: 'serve -s . -l 8799',
    url: 'http://127.0.0.1:8799',
    timeout: 15000,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: {} },
  ],
  reporter: 'html',
  timeout: 30000,
});
