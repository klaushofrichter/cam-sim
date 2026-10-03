import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeEngine } from './helpers';
import { Library } from '../src/media/library';
import { readFlv } from '../src/media/flv';
import request from 'supertest';
import { makeEngine as _m, listen, login } from './helpers';
import { createControlApp } from '../src/control-api/app';
import { createCameraApp } from '../src/camera-api/app';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
let src: string;

beforeAll(() => {
  src = mkdtempSync(join(tmpdir(), 'camsim-lib-src-'));
  // Any video file: converted.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(src, 'Garden Walk.mp4')]);
  // A captured pair (camera formats): copied.
  mkdirSync(join(src, 'porch-person'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=16000', '-t', '3', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac', join(src, 'porch-person', 'main.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=896x512:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=16000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(src, 'porch-person', 'sub.mp4')]);
  // Not a video.
  writeFileSync(join(src, 'broken.mp4'), 'not a video');
}, 120_000);

describe('video library', () => {
  it('lists the test pattern and every source, and prepares them one at a time', async () => {
    const engine = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-lib-cache-')) });
    await lib.prepareAll();
    const list = lib.list();
    expect(list.map((v) => [v.id, v.state])).toEqual([
      ['test-pattern', 'ready'],
      ['broken', 'failed'],
      ['garden-walk', 'ready'],
      ['porch-person', 'ready'],
    ]);
    expect(list.find((v) => v.id === 'porch-person')!.converted).toBe(false);
    expect(list.find((v) => v.id === 'garden-walk')!.converted).toBe(true);
    expect(list.find((v) => v.id === 'broken')!.error).toBeTruthy();
    expect(list.find((v) => v.id === 'garden-walk')!.durationS).toBeGreaterThan(2);
  }, 180_000);

  it('selecting a video switches live, snapshots and recordings to it', async () => {
    const engine = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-lib-cache-')) });
    await lib.prepareAll();
    const before = await engine.media.snapshot();
    expect(lib.select('garden-walk')).toBeNull();
    expect(engine.videoId).toBe('garden-walk');
    expect(Buffer.compare(await engine.media.snapshot(), before)).not.toBe(0);
    const main = readFlv(readFileSync(engine.media.clipPath('main').replace('clip-main.mp4', 'main.flv')));
    expect(main.tags.find((t) => t.type === 9)?.codecId).toBe(12);
    expect(engine.media.liveFlv('sub').tags.find((t) => t.type === 9)?.codecId).toBe(7);
    expect(readFileSync(engine.media.clipPath('sub')).subarray(4, 12).toString()).toBe('ftypmp42');
    expect(lib.select('broken')).toMatch(/not ready/);
    expect(lib.select('nope')).toMatch(/unknown/);
  }, 180_000);

  it('a recording keeps the video it was made from', async () => {
    const engine = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-lib-cache-')) });
    await lib.prepareAll();
    const a = engine.sd.add({ date: '2026-09-27', start: '010000', end: '010030', triggers: ['motion'], dst: true });
    lib.select('garden-walk');
    const b = engine.sd.add({ date: '2026-09-27', start: '020000', end: '020030', triggers: ['motion'], dst: true });
    expect(a.video).toBe('test-pattern');
    expect(b.video).toBe('garden-walk');
    for (const r of [a, b]) {
      for (const s of ['sub', 'main'] as const) {
        const m = engine.mediaFor(r);
        expect(m.clipSize(s)).toBe(r.files[s].size);
      }
    }
    expect(engine.sd.byId(a.id)!.files.main.size).not.toBe(b.files.main.size);
  }, 180_000);

  it('downloads serve a recording from the video it was made from', async () => {
    const engine = await _m({ CAMSIM_MAIN_SIZE: '640x360', CAMSIM_CONTROL_TOKEN: 't'.repeat(32) });
    const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-lib-cache-')) });
    await lib.prepareAll();
    const old = engine.sd.add({ date: '2026-09-27', start: '010000', end: '010030', triggers: ['motion'], dst: true });
    lib.select('garden-walk');
    const want = readFileSync(engine.mediaFor(old).clipPath('sub'));
    const ctl = await request(createControlApp(engine)).get(`/sim/api/recordings/${old.id}/sub`).set('Authorization', `Bearer ${'t'.repeat(32)}`).buffer(true)
      .parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(Number(ctl.headers['content-length'])).toBe(old.files.sub.size);
    expect(Buffer.compare(ctl.body as Buffer, want)).toBe(0);
    const cam = createCameraApp(engine, { port: 'http' });
    const token = await login(cam);
    const srv = await listen(cam);
    try {
      const r = await fetch(`${srv.url}/cgi-bin/api.cgi?cmd=Download&source=${old.files.sub.name}&output=x.mp4&token=${token}`);
      const body = Buffer.from(await r.arrayBuffer());
      expect(Number(r.headers.get('content-length'))).toBe(old.files.sub.size);
      expect(Buffer.compare(body, want)).toBe(0);
    } finally {
      await srv.close();
    }
  }, 180_000);

  it('a live stream switches to the selected video at once, timestamps still rising', async () => {
    const engine = await _m({ CAMSIM_MAIN_SIZE: '640x360', CAMSIM_CONTROL_TOKEN: 't'.repeat(32) });
    const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-lib-cache-')) });
    await lib.prepareAll();
    const srv = await listen(createControlApp(engine));
    const ac = new AbortController();
    try {
      const r = await fetch(`${srv.url}/sim/api/media/live/sub`, { headers: { Authorization: `Bearer ${'t'.repeat(32)}` }, signal: ac.signal });
      const reader = r.body!.getReader();
      const chunks: Buffer[] = [];
      const readFor = async (ms: number) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
      };
      await readFor(1000);
      expect(lib.select('garden-walk')).toBeNull();
      await readFor(1000);
      const { tags } = readFlv(Buffer.concat(chunks));
      const videoConfigs = tags.filter((t) => t.type === 9 && t.bytes[12] === 0);
      expect(videoConfigs.length).toBe(2);
      const ms = tags.filter((t) => t.type !== 18).map((t) => t.ms);
      for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]);
      expect(tags.some((t, i) => i > tags.indexOf(videoConfigs[1]) && t.type === 9)).toBe(true);
    } finally {
      ac.abort();
      await srv.close();
    }
  }, 180_000);

  it('reuses a prepared cache on the next start', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'camsim-lib-cache-'));
    const engine = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' });
    const a = new Library(engine, { sourceDir: src, cacheDir: cache });
    await a.prepareAll();
    const t0 = Date.now();
    const b = new Library(engine, { sourceDir: src, cacheDir: cache });
    await b.prepareAll();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(b.list().find((v) => v.id === 'garden-walk')!.state).toBe('ready');
  }, 180_000);
});
