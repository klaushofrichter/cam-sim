import { test, expect, type Page } from '@playwright/test';
import { TOKEN } from './env';

// Page navigation like cams and cam-proxy: a collapsible sidebar on desktop, a
// hamburger drawer on phones (767 px and narrower).

async function open(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByTestId('shell')).toBeVisible();
}
const width = async (page: Page) => (await page.getByTestId('sidebar').boundingBox())!.width;
const overflow = (page: Page) => page.evaluate(() => document.body.style.overflow);

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the sidebar has labels, collapses to icons, remembers it, and expands again', async ({ page }) => {
    await open(page, '/#/settings');
    await expect(page.getByTestId('hamburger')).toBeHidden();
    await expect.poll(() => width(page)).toBe(220);
    await expect(page.getByTestId('nav-simulator').locator('.label')).toBeVisible();
    const toggle = page.getByTestId('sidebar-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect.poll(() => width(page)).toBe(64);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('nav-simulator')).toHaveAttribute('title', 'Simulator');
    expect(await page.evaluate(() => localStorage.getItem('camsim-sidebar-collapsed'))).toBe('1');
    await page.reload();
    await expect.poll(() => width(page)).toBe(64);
    // Collapsed, the icons still navigate and show the active page.
    await page.getByTestId('nav-simulator').click();
    await expect(page).toHaveURL(/#\/simulator$/);
    await expect(page.getByTestId('nav-simulator')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('sidebar-toggle').click();
    await expect.poll(() => width(page)).toBe(220);
    await page.reload();
    await expect.poll(() => width(page)).toBe(220);
  });

  test('the theme toggle, Sign out and the camera line stay in the top bar', async ({ page }) => {
    await open(page, '/#/settings');
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await expect(page.getByTestId('logout')).toBeVisible();
    await expect(page.getByTestId('camera-name')).toHaveText('e2e-cam');
    await expect(page.getByTestId('camera-meta')).toContainText('·');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('no sidebar; a one-row top bar with the hamburger first', async ({ page }) => {
    await open(page, '/#/settings');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    const burger = page.getByTestId('hamburger');
    await expect(burger).toBeVisible();
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    // No aria-controls: the drawer exists only while open (as in cams).
    await expect(burger).not.toHaveAttribute('aria-controls', /./);
    const bar = (await page.getByTestId('topbar').boundingBox())!;
    expect(bar.height).toBeLessThan(60); // one row, no wrapping
    expect((await burger.boundingBox())!.x).toBeLessThan(20);
    await expect(page.getByTestId('camera-name')).toHaveText('e2e-cam');
    await expect(page.getByTestId('power-badge')).toBeVisible();
    // Theme, Sign out and the camera line move into the drawer.
    await expect(page.getByTestId('logout')).toBeHidden();
    await expect(page.getByTestId('theme-toggle')).toBeHidden();
    await expect(page.getByTestId('camera-meta')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('the hamburger opens the drawer; Escape closes it and focus returns', async ({ page }) => {
    await open(page, '/#/settings');
    const burger = page.getByTestId('hamburger');
    await burger.click();
    const drawer = page.getByTestId('drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    await expect(burger).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer.getByTestId('nav-live')).toBeFocused();
    await expect(drawer.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page');
    await expect(drawer.getByTestId('theme-toggle')).toBeVisible();
    await expect(drawer.getByTestId('drawer-logout')).toBeVisible();
    await expect(drawer.getByTestId('drawer-meta')).toContainText('·');
    // The page behind is inert and doesn't scroll.
    expect(await overflow(page)).toBe('hidden');
    expect(await page.evaluate(() => document.querySelector('main')!.closest('[inert]') !== null)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(burger).toBeFocused();
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    expect(await overflow(page)).toBe('');
  });

  test('navigating from the drawer closes it and shows the page', async ({ page }) => {
    await open(page, '/#/settings');
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-simulator').click();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/simulator$/);
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer').getByTestId('nav-simulator')).toHaveAttribute('aria-current', 'page');
  });

  test('a tap on the backdrop or the close button closes the drawer', async ({ page }) => {
    await open(page, '/#/settings');
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    // The drawer is 260 px wide; the backdrop shows to its right.
    await page.getByTestId('drawer-backdrop').click({ position: { x: 340, y: 400 } });
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer-close').click();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
  });

  test('growing to desktop width closes the drawer, releases the scroll lock and shows the sidebar', async ({ page }) => {
    await open(page, '/#/settings');
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    expect(await overflow(page)).toBe('');
  });

  test('Back and Forward close the drawer', async ({ page }) => {
    await open(page, '/#/settings');
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-simulator').click();
    await expect(page).toHaveURL(/#\/simulator$/);
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(page.getByTestId('hamburger')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/#\/simulator$/);
    await expect(page.getByTestId('drawer')).toHaveCount(0);
  });

  test('Sign out from the drawer closes it: the sign-in page scrolls, and the next sign-in starts closed', async ({ page }) => {
    await open(page, '/#/settings');
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('drawer-logout').click();
    await expect(page.getByTestId('token-input')).toBeVisible();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    expect(await overflow(page)).toBe('');
    await page.getByTestId('token-input').fill(TOKEN);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('shell')).toBeVisible();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(page.getByTestId('hamburger')).toHaveAttribute('aria-expanded', 'false');
    expect(await overflow(page)).toBe('');
  });
});
