import { test, expect } from '@playwright/test';
import { signIn, resetSim } from './helpers';

test.beforeEach(async ({ request }) => resetSim(request));

test('live plays the sub stream', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/live');
  const video = page.getByTestId('live-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(t0);
});

test('a person trigger records, shows in Playback, plays and downloads', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/live');
  await page.getByTestId('trigger-duration').selectOption('5');
  await page.getByTestId('trigger-person').click();
  await expect(page.getByTestId('trigger-result')).toContainText('Recording');
  await page.getByTestId('nav-playback').click();
  const row = page.getByTestId('recording-row').filter({ hasText: 'person' }).last();
  await expect(row).toBeVisible();
  await row.click();
  const player = page.getByTestId('playback-video');
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const href = await page.getByTestId('download-sub').getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('video/mp4');
});
