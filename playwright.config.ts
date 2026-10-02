import { defineConfig, devices } from '@playwright/test';
import { SIM_ENV, UI_PORT, STATE_FILE } from './e2e/env';

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
  projects: [
    // One real sign-in for the run (the control sign-in allows 20 attempts per
    // 15 min per address); the other specs reuse its storageState.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'e2e', dependencies: ['setup'], testIgnore: [/auth\.setup\.ts/, /login\.spec\.ts/], use: { storageState: STATE_FILE } },
    // The sign-in form itself: real sign-ins, no saved session. After 'e2e' so
    // the shared state is made first; it never touches it.
    { name: 'login', dependencies: ['e2e'], testMatch: /login\.spec\.ts/, use: { storageState: { cookies: [], origins: [] } } },
  ],
  webServer: {
    command: 'node e2e/make-library.mjs && node dist/src/cli.js',
    port: UI_PORT,
    reuseExistingServer: !process.env.CI,
    env: SIM_ENV,
  },
});
