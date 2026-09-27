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
    await yard.getByRole('button').click();
    await expect(yard.getByTestId('video-state')).toContainText('showing');
    expect(Buffer.compare(await snap(), before)).not.toBe(0);
    expect((await (await request.get('http://127.0.0.1:19443/sim/api/videos', { headers })).json()).selected).toBe('yard');
  } finally {
    await request.post('http://127.0.0.1:19443/sim/api/reset', { headers, data: { video: true } });
  }
});
