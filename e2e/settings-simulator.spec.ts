import { test, expect } from '@playwright/test';
import { signIn, resetSim, camLogin, camCmd } from './helpers';
import { CAM_PORT, TOKEN, UI_PORT } from './env';

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

test('a fault toggle that the API refuses shows the fault as off', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  const row = page.getByTestId('fault-downloads.dropFirst');
  await row.getByLabel('downloads.dropFirst count').fill('0'); // count must be 1 or more
  await row.getByTestId('fault-toggle').click();
  await expect(page.getByRole('status')).toContainText('count');
  await expect(row.getByTestId('fault-toggle')).not.toBeChecked();
});

// SD pipeline (spec 2026-09-29): switched on for a chosen time, off again.
test('the SD pipeline card switches on for a chosen time, shows the time left, and off', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  const card = page.getByTestId('pipeline-card');
  await card.getByTestId('pipeline-minutes').selectOption('15');
  await card.getByTestId('pipeline-toggle').check();
  await expect(card.getByTestId('pipeline-left')).toHaveText(/1[45] min left/);
  await card.getByTestId('pipeline-toggle').uncheck();
  await expect(card.getByTestId('pipeline-left')).toHaveCount(0);
});

// Issue #46: the card's choices, a refused switch-on, and a camera that is off.
test('the SD pipeline card offers durations up to CAMSIM_PIPELINE_MAX_MIN', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  await expect(page.getByTestId('pipeline-card').getByTestId('pipeline-minutes').locator('option')).toHaveText(['15 min', '1 h', '4 h', '5 h']);
});

test('a refused SD pipeline switch-on leaves the switch off', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  await page.route('**/sim/api/pipeline', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"invalid","detail":"refused for the test"}' }));
  const card = page.getByTestId('pipeline-card');
  await card.getByTestId('pipeline-toggle').click();
  await expect(page.getByRole('status')).toContainText('refused for the test');
  await expect(card.getByTestId('pipeline-toggle')).not.toBeChecked();
});

test('the SD pipeline card says it waits while the camera is off', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  const card = page.getByTestId('pipeline-card');
  await card.getByTestId('pipeline-toggle').check();
  await expect(card.getByTestId('pipeline-left')).toBeVisible();
  await request.post(`http://127.0.0.1:${UI_PORT}/sim/api/actions/power-off`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await expect(card.getByTestId('pipeline-left')).toContainText('waiting for the camera');
  await expect(card.getByTestId('pipeline-left')).not.toContainText('starting');
});

test('with CAMSIM_PIPELINE_MAX_MIN below 60, the SD pipeline card starts at the max and sends it', async ({ page }) => {
  // The simulator runs with 300; the state read by the page says 30.
  await page.route('**/sim/api/state', async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), pipelineMaxMin: 30 } });
  });
  await signIn(page);
  await page.goto('/#/simulator');
  const card = page.getByTestId('pipeline-card');
  await expect(card.getByTestId('pipeline-minutes').locator('option')).toHaveText(['15 min', '30 min']);
  await expect(card.getByTestId('pipeline-minutes')).toHaveValue('30');
  const sent = page.waitForRequest((r) => r.url().endsWith('/sim/api/pipeline') && r.method() === 'POST');
  await card.getByTestId('pipeline-toggle').check();
  expect((await sent).postDataJSON()).toEqual({ minutes: 30 });
  await expect(card.getByTestId('pipeline-left')).toHaveText(/(29|30) min left/);
});
