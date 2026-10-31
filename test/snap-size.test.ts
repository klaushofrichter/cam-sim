// Snap answers at the main stream's size, as GetEnc reports it (#126); the
// web/control snapshot stays at the fixture's sub size.
import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import request from 'supertest';
import { fixedClock } from '../src/engine/clock';
import { createLogger } from '../src/log';
import { createControlApp } from '../src/control-api/app';
import { findFonts } from '../src/pipeline/fonts';
import { makeCamera, makeEngine, login } from './helpers';

// Width and height from a JPEG's SOF marker.
function jpegSize(b: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('not a JPEG marker');
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

async function snap(app: Parameters<typeof request>[0], t: string): Promise<Buffer> {
  const res = await request(app).get(`/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=x&token=${t}`).buffer(true);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/image\/jpeg/);
  return Buffer.from(res.body);
}

describe('Snap size (#126)', () => {
  it.each([
    ['RLC-1224A', { width: 4512, height: 2512 }, { width: 896, height: 512 }],
    ['CX820', { width: 3840, height: 2160 }, { width: 640, height: 360 }],
    ['E1-Outdoor-Pro', { width: 3840, height: 2160 }, { width: 640, height: 360 }],
  ])('%s: Snap is GetEnc main size; the control snapshot stays the sub size', async (model, main, sub) => {
    const { app, engine } = await makeCamera({ CAMSIM_MODEL: model, CAMSIM_CONTROL_TOKEN: 'tok' });
    expect(engine.profile.enc.mainStream).toMatchObject(main);
    const t = await login(app);
    expect(jpegSize(await snap(app, t))).toEqual(main);
    const ctl = await request(createControlApp(engine)).get('/sim/api/media/snapshot').set('Authorization', 'Bearer tok').buffer(true);
    expect(jpegSize(Buffer.from(ctl.body))).toEqual(sub);
    expect(jpegSize(await engine.media.snapshot())).toEqual(sub);
  });

  it('same picture → the cached Snap (one scale per video)', async () => {
    const { app, engine } = await makeCamera();
    const t = await login(app);
    const a = await engine.snapMain();
    expect(await engine.snapMain()).toBe(a);
    expect((await snap(app, t)).equals(a)).toBe(true);
  });

  it.skipIf(!findFonts())('E1: Snap shows the position and changes after a move', async () => {
    const clock = fixedClock(new Date('2026-10-30T12:00:00Z'));
    const { engine } = await makeCamera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' }, { clock });
    const a = await engine.snapMain();
    engine.ptz!.control({ op: 'Left', speed: 32 });
    clock.advance(1000);
    const b = await engine.snapMain();
    expect(b.equals(a)).toBe(false);
    expect(jpegSize(b)).toEqual({ width: 3840, height: 2160 });
  });

  it('a failing ffmpeg: Snap falls back to the sub picture, logged once', async () => {
    let out = '';
    const log = createLogger('warn', new Writable({ write(c, _e, cb) { out += c; cb(); } }));
    const e = await makeEngine({}, { log });
    e.ffmpeg = '/nonexistent';
    const plain = await e.media.snapshot();
    expect((await e.snapMain()).equals(plain)).toBe(true);
    expect((await e.snapMain()).equals(plain)).toBe(true);
    expect(out.match(/snap_scale_failed/g)).toHaveLength(1);
  });
});
