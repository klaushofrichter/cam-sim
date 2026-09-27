import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { makeEngine } from './helpers';
import { Library } from '../src/media/library';
import { FixtureMedia, fixturePaths } from '../src/media/fixtures';
import { createControlApp } from '../src/control-api/app';
import { listen } from './helpers';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const clip = (file: string, seconds = 2) =>
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
let src: string;

beforeAll(() => {
  src = tmp('camsim-edge-src-');
  clip(join(src, 'garden.mp4'), 3);
}, 60_000);

describe('video library edges', () => {
  it('keeps the built-in test pattern and gives colliding or long names their own ids', async () => {
    const dir = tmp('camsim-edge-ids-');
    for (const n of ['Test Pattern.mp4', 'a b.mp4', 'a-b.mp4', `${'x'.repeat(100)}.mp4`]) writeFileSync(join(dir, n), 'x');
    const lib = new Library(await makeEngine(), { sourceDir: dir, cacheDir: tmp('camsim-edge-c-') });
    const list = lib.list();
    expect(list[0]).toMatchObject({ id: 'test-pattern', name: 'Test pattern', state: 'ready' });
    const ids = list.map((v) => v.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(expect.arrayContaining(['a-b', 'a-b-2', 'test-pattern-2']));
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(48);
  });

  it('after a restart, cached videos are ready at once, also when the source is gone', async () => {
    const cache = tmp('camsim-edge-cache-');
    const e1 = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    const a = new Library(e1, { sourceDir: src, cacheDir: cache });
    await a.prepareAll();
    const size = e1.mediaFor({ video: 'garden' }).clipSize('main');

    const e2 = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    const b = new Library(e2, { sourceDir: src, cacheDir: cache });
    expect(b.list().find((v) => v.id === 'garden')!.state).toBe('ready');
    expect(e2.mediaFor({ video: 'garden' }).clipSize('main')).toBe(size);

    const e3 = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    new Library(e3, { sourceDir: tmp('camsim-edge-empty-'), cacheDir: cache });
    expect(e3.mediaFor({ video: 'garden' }).clipSize('main')).toBe(size);
  }, 120_000);

  it('refuses to select a video whose cache files went missing, instead of crashing later', async () => {
    const engine = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    const lib = new Library(engine, { sourceDir: src, cacheDir: tmp('camsim-edge-miss-') });
    await lib.prepareAll();
    rmSync(join(dirname(engine.mediaFor({ video: 'garden' }).clipPath('main')), 'sub.flv'));
    expect(lib.select('garden')).toMatch(/files/);
    expect(engine.videoId).toBe('test-pattern');
  }, 120_000);

  it('instances sharing a cache with different sizes keep their own copies', async () => {
    const cache = tmp('camsim-edge-shared-');
    const e1 = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    await new Library(e1, { sourceDir: src, cacheDir: cache }).prepareAll();
    const e2 = await makeEngine({ CAMSIM_MAIN_SIZE: '320x180' });
    await new Library(e2, { sourceDir: src, cacheDir: cache }).prepareAll();
    const m1 = e1.mediaFor({ video: 'garden' });
    const m2 = e2.mediaFor({ video: 'garden' });
    expect(m1.clipPath('main')).not.toBe(m2.clipPath('main'));
    expect(existsSync(m1.clipPath('main'))).toBe(true);
    expect(statSync(m1.clipPath('main')).size).toBe(m1.clipSize('main'));
  }, 120_000);

  it('trims long sources to CAMSIM_MAX_VIDEO_S', async () => {
    const engine = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360', CAMSIM_MAX_VIDEO_S: '2' });
    const lib = new Library(engine, { sourceDir: src, cacheDir: tmp('camsim-edge-trim-') });
    await lib.prepareAll();
    expect(lib.list().find((v) => v.id === 'garden')!.durationS).toBeLessThanOrEqual(2.3);
  }, 120_000);

  it('prepares a captured pair without sound', async () => {
    const dir = tmp('camsim-edge-pair-');
    mkdirSync(join(dir, 'quiet'));
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20', '-t', '2', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', join(dir, 'quiet', 'main.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=896x512:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'quiet', 'sub.mp4')]);
    const lib = new Library(await makeEngine(), { sourceDir: dir, cacheDir: tmp('camsim-edge-pc-') });
    await lib.prepareAll();
    expect(lib.list().find((v) => v.id === 'quiet')).toMatchObject({ state: 'ready', converted: false });
  }, 120_000);

  it('a live stream whose new video cannot be read ends, and the process lives on', async () => {
    const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: 'k'.repeat(32) });
    const srv = await listen(createControlApp(engine));
    try {
      const r = await fetch(`${srv.url}/sim/api/media/live/sub`, { headers: { Authorization: `Bearer ${'k'.repeat(32)}` } });
      const reader = r.body!.getReader();
      await reader.read();
      engine.setMedia(new FixtureMedia(fixturePaths(join(tmpdir(), 'camsim-does-not-exist'))), 'gone');
      const ended = await (async () => {
        try {
          for (;;) if ((await reader.read()).done) return true;
        } catch {
          return true;
        }
      })();
      expect(ended).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
