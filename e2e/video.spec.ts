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
    await expect(page.getByTestId('video-test-pattern').getByTestId('video-state')).toContainText('playing now');
    const t = await camLogin(request);
    const snap = async () => (await request.get(`http://127.0.0.1:${CAM_PORT}/cgi-bin/api.cgi?cmd=Snap&token=${t}`)).body();
    const before = await snap();
    await yard.getByRole('checkbox').check();
    await expect(yard.getByTestId('video-state')).toContainText('playing now');
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

// The picker's states from a mocked video list (#154, Task 6): no library
// videos needed, nothing on the simulator changes.
const v = (id: string, compat: string) => ({ id, name: id, state: 'ready', converted: true, durationS: 4, compat });
const list = (sequence: string[], playing: string, videos = [{ id: 'test-pattern', name: 'Test pattern', state: 'ready' }, v('yard', 'k1'), v('lane', 'k1'), v('dock', 'k2')]) =>
  ({ selected: sequence[0], sequence, playing, videos });

test('a video with another encoding is disabled while a video is checked', async ({ page }) => {
  await page.route('**/sim/api/videos', (r) => r.fulfill({ json: list(['yard'], 'yard') }));
  await signIn(page);
  await page.goto('/#/simulator');
  const dock = page.getByTestId('video-dock');
  await expect(dock.getByRole('checkbox')).toBeDisabled();
  await expect(dock).toContainText('Different encoding');
  await expect(dock.locator('label.off')).toHaveCount(1);
  await expect(page.getByTestId('video-lane').getByRole('checkbox')).toBeEnabled();
  // one checked video plays like a sequence's: "playing now"
  await expect(page.getByTestId('video-yard').getByTestId('video-state')).toContainText('playing now');
});

test('a sequence\'s "playing now" follows the clock without a click', async ({ page }) => {
  let playing = 'yard';
  await page.route('**/sim/api/videos', (r) => r.fulfill({ json: list(['yard', 'lane'], playing) }));
  await signIn(page);
  await page.goto('/#/simulator');
  await expect(page.getByTestId('video-yard').getByTestId('video-state')).toContainText('playing now');
  playing = 'lane';
  await expect(page.getByTestId('video-lane').getByTestId('video-state')).toContainText('playing now', { timeout: 5_000 });
  await expect(page.getByTestId('video-yard').getByTestId('video-state')).toContainText('in sequence');
});

test('rows do not dim while a change is on its way, and a list error clears on the next load', async ({ page }) => {
  let fail = false;
  let sequence = ['yard'];
  await page.route('**/sim/api/videos', (r) => (fail ? r.fulfill({ status: 500, json: { error: 'x' } }) : r.fulfill({ json: list(sequence, sequence[0]) })));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/sim/api/video', async (r) => {
    await held;
    sequence = ['yard', 'lane'];
    await r.fulfill({ json: { selected: 'yard', sequence } });
  });
  await signIn(page);
  await page.goto('/#/simulator');
  const lane = page.getByTestId('video-lane');
  await lane.getByRole('checkbox').check();
  await expect(lane.getByRole('checkbox')).toBeDisabled(); // busy
  await expect(page.getByTestId('videos').locator('label.off')).toHaveCount(1); // only dock (other encoding)
  release();
  await expect.poll(() => sequence.length).toBe(2);
  await expect(lane.getByTestId('video-state')).toContainText('in sequence');
  fail = true; // the 3 s poll fails once …
  await expect(page.getByText('The video list could not be loaded.')).toBeVisible({ timeout: 5_000 });
  fail = false; // … and the message goes with the next good one
  await expect(page.getByText('The video list could not be loaded.')).toHaveCount(0, { timeout: 5_000 });
});
