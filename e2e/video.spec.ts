import { test, expect } from '@playwright/test';
import { signIn, resetSim, camLogin } from './helpers';
import { CAM_PORT, TOKEN } from './env';

test.beforeEach(async ({ request }) => resetSim(request));

test('selecting a library video changes what the camera shows', async ({ page, request }) => {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  try {
    await signIn(page);
    await page.goto('/#/simulator');
    const yard = page.getByTestId('video-yard');
    await expect(yard.getByTestId('video-state')).toContainText('converted', { timeout: 60_000 });
    await expect(page.getByTestId('video-test-pattern').getByTestId('video-state')).toContainText('showing');
    const t = await camLogin(request);
    const snap = async () => (await request.get(`http://127.0.0.1:${CAM_PORT}/cgi-bin/api.cgi?cmd=Snap&token=${t}`)).body();
    const before = await snap();
    await yard.getByRole('checkbox').check();
    await expect(yard.getByTestId('video-state')).toContainText('showing');
    expect(Buffer.compare(await snap(), before)).not.toBe(0);
    expect((await (await request.get('http://127.0.0.1:19443/sim/api/videos', { headers })).json()).selected).toBe('yard');
  } finally {
    await request.post('http://127.0.0.1:19443/sim/api/reset', { headers, data: { video: true } });
  }
});

test('checking two videos plays them as a sequence', async ({ page, request }) => {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const videos = async () => (await request.get('http://127.0.0.1:19443/sim/api/videos', { headers })).json();
  try {
    await signIn(page);
    await page.goto('/#/simulator');
    const yard = page.getByTestId('video-yard');
    const lane = page.getByTestId('video-lane');
    await expect(yard.getByTestId('video-state')).toContainText('converted', { timeout: 60_000 });
    await expect(lane.getByTestId('video-state')).toContainText('converted', { timeout: 60_000 });
    await yard.getByRole('checkbox').check();
    const tp = page.getByTestId('video-test-pattern');
    await expect(tp.getByRole('radio')).toBeEnabled();
    await expect(tp).not.toContainText('Different encoding');
    await expect(tp.locator('label.off')).toHaveCount(0);
    await lane.getByRole('checkbox').check();
    await expect.poll(async () => (await videos()).sequence).toEqual(['lane', 'yard']);
    await expect(page.getByText('playing now')).toHaveCount(1);
    await page.getByTestId('video-test-pattern').getByRole('radio').check();
    await expect.poll(async () => (await videos()).sequence).toEqual(['test-pattern']);
  } finally {
    await request.post('http://127.0.0.1:19443/sim/api/reset', { headers, data: { video: true } });
  }
});
