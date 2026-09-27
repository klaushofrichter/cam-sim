import { defineConfig, devices } from '@playwright/test';
import { SIM_ENV, UI_PORT } from './e2e/env';

// Requires `npm run build` first. One simulator with the web UI on; the specs
// share it (faults, power), so they run one at a time.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    // Chrome, not the bundled Chromium: it plays H.264/AAC, as a user's browser does.
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'node dist/src/cli.js',
    port: UI_PORT,
    reuseExistingServer: !process.env.CI,
    env: SIM_ENV,
  },
});
