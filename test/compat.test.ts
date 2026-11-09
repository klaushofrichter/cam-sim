import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeEngine } from './helpers';
import { Library } from '../src/media/library';
import { compatKey } from '../src/media/compat';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
let dir: string;

// A 640x360 H.265 main and a 320x180 H.264 sub, 2 s, silent AAC.
function pair(name: string, o: { hue?: boolean; preset?: string; rate?: number } = {}): { main: string; sub: string } {
  const main = join(dir, `${name}-main.mp4`);
  const sub = join(dir, `${name}-sub.mp4`);
  const src = (size: string) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=15`, '-f', 'lavfi', '-i', `anullsrc=r=${o.rate ?? 16000}:cl=mono`, '-t', '2'];
  const hue = o.hue ? ['-vf', 'hue=h=120'] : [];
  const audio = ['-c:a', 'aac', '-ar', String(o.rate ?? 16000)];
  ff([...src('640x360'), ...hue, '-c:v', 'libx265', '-preset', o.preset ?? 'veryfast', '-x265-params', 'keyint=30:bframes=0:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', ...audio, main]);
  ff([...src('320x180'), ...hue, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...audio, sub]);
  return { main, sub };
}

beforeAll(() => {
  dir = tmp('camsim-compat-');
}, 60_000);

describe('compatibility key', () => {
  it('same recipe, different content → same key', async () => {
    const a = pair('a');
    const b = pair('b', { hue: true });
    const [ka, kb] = [await compatKey(a.main, a.sub), await compatKey(b.main, b.sub)];
    expect(ka).toMatch(/^[0-9a-f]{16}$/);
    expect(ka).toBe(kb);
  }, 60_000);

  it('different x265 preset → different key', async () => {
    const a = pair('p1', { preset: 'veryfast' });
    const b = pair('p2', { preset: 'medium' });
    expect(await compatKey(a.main, a.sub)).not.toBe(await compatKey(b.main, b.sub));
  }, 60_000);

  it('different audio sample rate → different key', async () => {
    const a = pair('r1', { rate: 16000 });
    const b = pair('r2', { rate: 48000 });
    expect(await compatKey(a.main, a.sub)).not.toBe(await compatKey(b.main, b.sub));
  }, 60_000);

  it('a prepared library video reports compat in list()', async () => {
    const src = tmp('camsim-compat-src-');
    const p = pair('lib');
    mkdirSync(join(src, 'pair'));
    copyFileSync(p.main, join(src, 'pair', 'main.mp4'));
    copyFileSync(p.sub, join(src, 'pair', 'sub.mp4'));
    const lib = new Library(await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' }), { sourceDir: src, cacheDir: tmp('camsim-compat-c-') });
    await lib.prepareAll();
    const list = lib.list();
    expect(list.find((v) => v.id === 'pair')!.compat).toMatch(/^[0-9a-f]{16}$/);
    expect(list.find((v) => v.id === 'test-pattern')!.compat).toBeUndefined();
  }, 120_000);
});
