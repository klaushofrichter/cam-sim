import { test, expect } from '@playwright/test';
import { signIn, resetSim, camLogin, camCmd } from './helpers';
import { CAM_PORT } from './env';

test.beforeEach(async ({ request }) => resetSim(request));

test('a settings save writes the whole object, like the camera API', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/#/settings');
  await page.getByTestId('isp-daynight').selectOption('Color');
  await page.getByTestId('save-image').click();
  await expect(page.getByTestId('save-image-state')).toHaveText('Saved');
  const t = await camLogin(request);
  const isp = (await camCmd(request, t, 'GetIsp')).value.Isp;
  expect(isp.dayNight).toBe('Color');
  expect(isp.rotation).toBe(0);
});

test('an invalid OSD name shows the camera error and changes nothing', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/#/settings');
  await page.getByTestId('osd-name').fill('x'.repeat(32));
  await page.getByTestId('save-osd').click();
  await expect(page.getByTestId('save-osd-state')).toContainText('-56');
  const t = await camLogin(request);
  expect((await camCmd(request, t, 'GetOsd')).value.Osd.osdChannel.name).toBe('e2e-cam');
});

test('a fault switched on in the UI changes what the camera answers', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  const t = await camLogin(request);
  const snap = () => request.get(`http://127.0.0.1:${CAM_PORT}/cgi-bin/api.cgi?cmd=Snap&token=${t}`).then((r) => r.status());
  expect(await snap()).toBe(200);
  await page.getByTestId('fault-snap.fail').getByTestId('fault-toggle').click();
  await expect.poll(snap).toBe(500);
  await page.getByTestId('fault-snap.fail').getByTestId('fault-toggle').click();
  await expect.poll(snap).toBe(200);
});

test('power off and on from the UI', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('power-off').click();
  await expect(page.getByTestId('power-state')).toHaveText('off');
  await expect(request.get(`http://127.0.0.1:${CAM_PORT}/cgi-bin/api.cgi?cmd=Snap`)).rejects.toThrow();
  await page.getByTestId('boot-ms').fill('200');
  await page.getByTestId('power-on').click();
  await expect(page.getByTestId('power-state')).toHaveText('on', { timeout: 10_000 });
});

test('camera requests show up in the live log', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  await camLogin(request);
  await expect(page.getByTestId('log-row').filter({ hasText: 'Login' }).first()).toBeVisible();
});
