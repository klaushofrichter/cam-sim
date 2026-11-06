import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeEngine } from './helpers';
import { Library } from '../src/media/library';

// Records every ffmpeg call the library makes, and still runs it (vi.mock is
// hoisted above the imports).
const calls: string[][] = [];
vi.mock('../src/media/fixtures', async (orig) => {
  const real = await orig<typeof import('../src/media/fixtures')>();
  return { ...real, ffmpeg: (args: string[], signal?: AbortSignal) => { calls.push(args); return real.ffmpeg(args, signal); } };
});

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('video library memory', () => {
  // A 4512x2512 H.265 frame decoded with ffmpeg's default thread count (one
  // per CPU) took over 512 MiB, and the cluster's cam2 (limit 512Mi) was
  // OOM-killed while preparing a camera-sized pair (2026-11-06).
  it('decodes the main copy with one thread (snapshot, ext stream)', async () => {
    const src = tmp('camsim-threads-src-');
    const pair = join(src, 'cam-pair');
    mkdirSync(pair);
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20', '-t', '2', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', join(pair, 'main.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(pair, 'sub.mp4')]);
    for (const model of ['RLC-1224A', 'CX820']) {
      calls.length = 0;
      const engine = await makeEngine({ CAMSIM_MODEL: model, CAMSIM_MAIN_SIZE: '640x360' });
      const lib = new Library(engine, { sourceDir: src, cacheDir: tmp('camsim-threads-cache-') });
      await lib.prepareAll();
      expect(lib.list().find((v) => v.id === 'cam-pair')!.state).toBe('ready');
      // Every call that decodes the main copy (not a stream copy) limits its decoder.
      const readsMain = (a: string[]) => a[a.indexOf('-i') + 1]?.endsWith('clip-main.mp4');
      const streamCopy = (a: string[]) => a.includes('-c') && a[a.indexOf('-c') + 1] === 'copy';
      const decodes = calls.filter((a) => readsMain(a) && !streamCopy(a));
      expect(decodes.length).toBeGreaterThan(0);
      for (const a of decodes) expect(a.slice(0, a.indexOf('-i'))).toEqual(expect.arrayContaining(['-threads', '1']));
    }
  }, 120_000);
});
