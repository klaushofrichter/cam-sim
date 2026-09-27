import { test, expect } from '@playwright/test';
import { TOKEN } from './env';
import { signIn } from './helpers';

test('a wrong token shows an error; the right one opens the app', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill('wrong');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toBeVisible();
  await page.getByTestId('token-input').fill(TOKEN);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('camera-name')).toHaveText('e2e-cam');
});

test('the session survives a reload and the token is kept nowhere in the page', async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(page.getByTestId('shell')).toBeVisible();
  const kept = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, u: location.href, h: document.documentElement.outerHTML }));
  expect(kept).not.toContain(TOKEN);
});

test('logout returns to the login page', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('token-input')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('token-input')).toBeVisible();
});

test('a tampered session cookie returns to the login page', async ({ page, context }) => {
  await signIn(page);
  const [c] = (await context.cookies()).filter((x) => x.name.startsWith('camsim_session_'));
  await context.addCookies([{ ...c, value: c.value.replace(/.$/, (x) => (x === '0' ? '1' : '0')) }]);
  await page.reload();
  await expect(page.getByTestId('token-input')).toBeVisible();
});
