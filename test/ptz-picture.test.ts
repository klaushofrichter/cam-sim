// The PTZ position on snapshots (E1-Outdoor-Pro); fixed models unchanged.
import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import request from 'supertest';
import { fixedClock } from '../src/engine/clock';
import { findFonts } from '../src/pipeline/fonts';
import { drawTextOnJpeg } from '../src/pipeline/ptz-picture';
import { createLogger } from '../src/log';
import { createControlApp } from '../src/control-api/app';
import { makeCamera, makeEngine, login } from './helpers';

const fonts = findFonts();
const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;

describe.skipIf(!fonts)('PTZ snapshots', () => {
  it('drawTextOnJpeg draws on a JPEG and gives a JPEG back', async () => {
    const e = await makeEngine();
    const plain = await e.media.snapshot();
    const out = await drawTextOnJpeg(plain, 'PAN 180 TILT 25 ZOOM 7', fonts!.regular);
    expect(isJpeg(out)).toBe(true);
    expect(out.equals(plain)).toBe(false);
  });

  it('E1 snapshot differs from the fixture and changes after a move; same state → cached (one ffmpeg run)', async () => {
    const clock = fixedClock(new Date('2026-10-30T12:00:00Z'));
    const e = await makeEngine({ CAMSIM_MODEL: 'E1-Outdoor-Pro' }, { clock });
    const plain = await e.media.snapshot();
    const a = await e.snapshot();
    expect(isJpeg(a)).toBe(true);
    expect(a.equals(plain)).toBe(false);
    expect(await e.snapshot()).toBe(a); // the cached buffer itself
    e.ptz!.control({ op: 'Left', speed: 32 });
    clock.advance(1000);
    const b = await e.snapshot();
    expect(b.equals(a)).toBe(false);
    expect(await e.snapshot()).toBe(b);
  });

  it('Snap and the control API snapshot serve the overlaid picture on the E1', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_MODEL: 'E1-Outdoor-Pro', CAMSIM_CONTROL_TOKEN: 'tok' });
    const t = await login(app);
    const want = await engine.snapshot();
    const snap = await request(app).get(`/cgi-bin/api.cgi?cmd=Snap&channel=0&token=${t}`).buffer(true);
    expect(snap.headers['content-type']).toMatch(/image\/jpeg/);
    expect(Buffer.from(snap.body).equals(want)).toBe(true);
    const ctl = await request(createControlApp(engine)).get('/sim/api/media/snapshot').set('Authorization', 'Bearer tok').buffer(true);
    expect(Buffer.from(ctl.body).equals(want)).toBe(true);
  });

  it('RLC-1224A snapshot is the fixture byte for byte (review focus 4)', async () => {
    const { app, engine } = await makeCamera();
    const plain = await engine.media.snapshot();
    expect((await engine.snapshot()).equals(plain)).toBe(true);
    const t = await login(app);
    const snap = await request(app).get(`/cgi-bin/api.cgi?cmd=Snap&channel=0&token=${t}`).buffer(true);
    expect(Buffer.from(snap.body).equals(plain)).toBe(true);
  });

  it('a failing ffmpeg (ffmpeg path "/nonexistent") falls back to the fixture JPEG, no throw, logged once', async () => {
    let out = '';
    const log = createLogger('warn', new Writable({ write(c, _e, cb) { out += c; cb(); } }));
    const e = await makeEngine({ CAMSIM_MODEL: 'E1-Outdoor-Pro' }, { log });
    e.ffmpeg = '/nonexistent';
    const plain = await e.media.snapshot();
    expect((await e.snapshot()).equals(plain)).toBe(true);
    e.ptz!.zoomFocus({ op: 'ZoomPos', pos: 20 });
    expect((await e.snapshot()).equals(plain)).toBe(true);
    await expect(drawTextOnJpeg(plain, 'PAN 1', fonts!.regular, '/nonexistent')).rejects.toThrow();
    expect(out.match(/ptz_snapshot_failed/g)).toHaveLength(1);
  });

  it('without a font the E1 snapshot is the plain fixture', async () => {
    const e = await makeEngine({ CAMSIM_MODEL: 'E1-Outdoor-Pro', CAMSIM_FONT_DIR: '/nonexistent-fonts' });
    expect((await e.snapshot()).equals(await e.media.snapshot())).toBe(true);
  });
});
