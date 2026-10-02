import { test as setup, expect } from '@playwright/test';
import { TOKEN, STATE_FILE } from './env';

// One sign-in for the whole run, saved as storageState. The control sign-in
// allows 20 attempts per 15 minutes per address, and every spec used to sign in
// by itself. The session is a signed cookie (12 h) and sign-out only clears the
// browser's copy, so a sign-out in one spec doesn't end it for the others.

setup('sign in once', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill(TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
  await page.context().storageState({ path: STATE_FILE });
});
