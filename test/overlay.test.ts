import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clockText, filterChain, overlayOf, type OverlaySettings } from '../src/pipeline/overlay';
import { findFonts } from '../src/pipeline/fonts';

const FMT = { timeFmt: 'MM/DD/YYYY', hourFmt: 1 };
const TZ = 'America/Chicago';
const off: OverlaySettings = { rotation: 0, mirroring: 0, watermark: 0, name: { enable: 0, pos: 'Lower Right' }, time: { enable: 0, pos: 'Upper Left' } };
const fonts = findFonts()!;
const files = { clock: '/tmp/x/clock.txt', name: '/tmp/x/name.txt' };

describe('clockText', () => {
  it('matches the camera: MM/DD/YYYY, 12 h with lower-case am/pm, upper-case weekday', () => {
    expect(clockText(new Date('2026-09-29T16:51:48Z'), TZ, FMT)).toBe('09/29/2026 11:51:48 am TUE');
    expect(clockText(new Date('2026-09-29T17:05:00Z'), TZ, FMT)).toBe('09/29/2026 12:05:00 pm TUE');
    expect(clockText(new Date('2026-09-29T05:00:00Z'), TZ, FMT)).toBe('09/29/2026 12:00:00 am TUE');
  });
  it('uses 24 h without am/pm for hourFmt 0', () => {
    expect(clockText(new Date('2026-09-29T21:07:09Z'), TZ, { timeFmt: 'MM/DD/YYYY', hourFmt: 0 })).toBe('09/29/2026 16:07:09 TUE');
  });
  // Review focus 5: the repeated autumn hour reads the zone's local time both times.
  it('shows local time through a DST change', () => {
    expect(clockText(new Date('2026-11-01T06:30:00Z'), TZ, FMT)).toBe('11/01/2026 01:30:00 am SUN'); // CDT
    expect(clockText(new Date('2026-11-01T07:30:00Z'), TZ, FMT)).toBe('11/01/2026 01:30:00 am SUN'); // CST
  });
});

describe('filterChain', () => {
  it('is a plain pass-through (null) with everything off', () => {
    expect(filterChain(off, files, fonts)).toBe('null');
  });
  it('flips before any text: rotation → vflip, mirroring → hflip', () => {
    expect(filterChain({ ...off, rotation: 1 }, files, fonts)).toBe('vflip');
    expect(filterChain({ ...off, mirroring: 1 }, files, fonts)).toBe('hflip');
    const both = filterChain({ ...off, rotation: 1, mirroring: 1, time: { enable: 1, pos: 'Upper Left' } }, files, fonts);
    expect(both.indexOf('vflip')).toBeLessThan(both.indexOf('drawtext'));
    expect(both.startsWith('vflip,hflip,')).toBe(true);
  });
  it('reads name and time from files with expansion off (review focus 1)', () => {
    const f = filterChain({ ...off, name: { enable: 1, pos: 'Lower Right' }, time: { enable: 1, pos: 'Top Center' } }, files, fonts);
    expect(f).toContain(`textfile='${files.name}'`);
    expect(f).toContain(`textfile='${files.clock}'`);
    expect(f.match(/reload=1/g)).toHaveLength(2);
    expect(f.match(/expansion=none/g)).toHaveLength(2);
  });
  it('places the six positions with a 10 px margin', () => {
    const at = (pos: string) => filterChain({ ...off, name: { enable: 1, pos } }, files, fonts);
    expect(at('Upper Left')).toMatch(/x=10:y=10/);
    expect(at('Top Center')).toMatch(/x=\(w-text_w\)\/2:y=10/);
    expect(at('Upper Right')).toMatch(/x=w-text_w-10:y=10/);
    expect(at('Lower Left')).toMatch(/x=10:y=h-th-10/);
    expect(at('Bottom Center')).toMatch(/x=\(w-text_w\)\/2:y=h-th-10/);
    expect(at('Lower Right')).toMatch(/x=w-text_w-10:y=h-th-10/);
  });
  it('stacks time above name at a shared position, and moves Upper Left text below the watermark', () => {
    const bottom = filterChain({ ...off, name: { enable: 1, pos: 'Lower Left' }, time: { enable: 1, pos: 'Lower Left' } }, files, fonts);
    expect(bottom).toMatch(new RegExp(`textfile='${files.name}'[^,]*y=h-th-10`));
    expect(bottom).toMatch(new RegExp(`textfile='${files.clock}'[^,]*y=h-th-38`));
    const top = filterChain({ ...off, watermark: 1, time: { enable: 1, pos: 'Upper Left' } }, files, fonts);
    expect(top).toMatch(/text='Reolink'[^,]*x=10:y=10/);
    expect(top).toMatch(new RegExp(`textfile='${files.clock}'[^,]*x=10:y=54`));
  });
  it('maps the settings objects', () => {
    expect(overlayOf({ Isp: { rotation: 1, mirroring: 0 }, Osd: { watermark: 1, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 0, pos: 'Top Center' } } }))
      .toEqual({ rotation: 1, mirroring: 0, watermark: 1, name: { enable: 1, pos: 'Lower Right' }, time: { enable: 0, pos: 'Top Center' } });
  });
});

// Real ffmpeg on one test-pattern frame: the chain does what it says.
describe('filterChain in ffmpeg', () => {
  const W = 896, H = 512;
  const frame = (vf: string, dir: string) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=896x512:rate=10', '-frames:v', '1',
    '-vf', vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  it('rotation + mirroring turns the picture 180°', () => {
    const d = mkdtempSync(join(tmpdir(), 'ovl-'));
    const plain = frame('null', d);
    const turned = frame(filterChain({ ...off, rotation: 1, mirroring: 1 }, files, fonts), d);
    let same = 0;
    for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 7) {
      const a = (y * W + x) * 3, b = ((H - 1 - y) * W + (W - 1 - x)) * 3;
      if (Math.abs(plain[a] - turned[b]) + Math.abs(plain[a + 1] - turned[b + 1]) + Math.abs(plain[a + 2] - turned[b + 2]) < 12) same++;
    }
    expect(same / (Math.ceil(W / 7) * Math.ceil(H / 7))).toBeGreaterThan(0.98);
  });
  it('draws a name literally, even with %, {, :, quotes and non-ASCII (review focus 1)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ovl-'));
    const f = { clock: join(d, 'clock.txt'), name: join(d, 'name.txt') };
    writeFileSync(f.clock, '09/29/2026 11:51:48 am TUE');
    writeFileSync(f.name, `50% {off}: 'Dén' \\ "x"`);
    const plain = frame('null', d);
    const named = frame(filterChain({ ...off, name: { enable: 1, pos: 'Lower Right' } }, f, fonts), d);
    const diff = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; if (plain[i] !== named[i]) n++; }
      return n;
    };
    expect(diff(W - 300, H - 40, W - 10, H - 10)).toBeGreaterThan(200); // text drawn bottom right
    expect(diff(10, 10, 300, 40)).toBe(0); // nothing top left
  });
});
