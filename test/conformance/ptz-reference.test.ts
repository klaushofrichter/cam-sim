// The E1 sim against the real E1's answers (reference/E1-Outdoor-Pro/):
// the PTZ measurement replayed in order, and the PTZ Get captures.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fixedClock } from '../../src/engine/clock';
import { makeCamera, post, login } from '../helpers';

const REF = join(__dirname, '..', '..', 'reference', 'E1-Outdoor-Pro');
const read = (file: string) => JSON.parse(readFileSync(join(REF, file), 'utf8'));
const EXCHANGES: Array<{ cmd: string; param: unknown; res: any; ms: number }> = read('ptz-exchanges.json');

function shape(o: unknown): unknown {
  if (Array.isArray(o)) return o.length ? [shape(o[0])] : [];
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape((o as any)[k])]));
  return typeof o;
}

async function e1() {
  const clock = fixedClock(new Date('2026-10-30T12:00:00Z'));
  const cam = await makeCamera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' }, { clock });
  const t = await login(cam.app);
  return { clock, call: async (cmd: string, param: unknown) => (await post(cam.app, cmd, param, t)).reply };
}

describe('E1 PTZ conformance: the measured exchanges', () => {
  it('replays ptz-exchanges.json in order with the camera\'s answers', async () => {
    const { clock, call } = await e1();
    expect(EXCHANGES.length).toBeGreaterThan(50);
    let afterZoomInc: any;
    let sawZoomInc = false;
    for (const [i, ex] of EXCHANGES.entries()) {
      const prev = EXCHANGES[i - 1];
      const zoomStop = prev?.cmd === 'PtzCtrl' && (prev.param as any).op === 'ZoomInc' && (ex.param as any).op === 'Stop';
      clock.advance(zoomStop ? 1500 : 100);
      const reply = await call(ex.cmd, ex.param);
      const where = `#${i} ${ex.cmd} ${JSON.stringify(ex.param)}`;
      if (ex.cmd === 'GetZoomFocus') {
        expect(Object.keys(reply), where).toEqual(Object.keys(ex.res));
        expect(shape(reply), where).toEqual(shape(ex.res));
        expect(reply.range, where).toEqual(ex.res.range);
        const { zoom, focus } = reply.value.ZoomFocus;
        expect(zoom.pos, where).toBeGreaterThanOrEqual(0);
        expect(zoom.pos, where).toBeLessThanOrEqual(27);
        expect(focus.pos, where).toBeGreaterThanOrEqual(0);
        expect(focus.pos, where).toBeLessThanOrEqual(97);
        if (sawZoomInc && !afterZoomInc) afterZoomInc = reply;
      } else {
        expect(reply, where).toEqual(ex.res);
        if (ex.cmd === 'PtzCtrl' && (ex.param as any).op === 'ZoomInc') sawZoomInc = true;
      }
    }
    // Measured: speed 32 ZoomInc for 1.5 s, zoom 7 -> 26.
    expect(afterZoomInc.value.ZoomFocus.zoom.pos).toBe(26);
  });
});

describe('E1 PTZ conformance: a zoom while zooming (measured 2026-10-30)', () => {
  it('replays ptz-zoom-overlap.json in order with the camera\'s answers', async () => {
    const { clock, call } = await e1();
    const overlap: Array<{ cmd: string; param: unknown; res: any }> = read('ptz-zoom-overlap.json');
    expect(overlap.some((ex) => ex.res.error?.rspCode === -13)).toBe(true);
    for (const [i, ex] of overlap.entries()) {
      clock.advance(100);
      expect(await call(ex.cmd, ex.param), `#${i} ${JSON.stringify(ex.param)}`).toEqual(ex.res);
    }
  });
});

describe('E1 PTZ conformance: the Get captures', () => {
  it.each(['GetZoomFocus', 'GetPtzPreset', 'GetPtzGuard', 'GetPtzCheckState', 'GetAutoFocus', 'GetPtzPatrol'])('%s has the captured shape and range', async (cmd) => {
    const { call } = await e1();
    const file = read(`${cmd}.json`);
    const reply = await call(cmd, { channel: 0 });
    expect(Object.keys(reply)).toEqual(Object.keys(file));
    expect(shape(reply)).toEqual(shape(file));
    expect(reply.range).toEqual(file.range);
  });

  it.each(['GetPtzCurPos', 'GetPtzTattern', 'GetPtzSerial', 'GetPtzTraceSection'])('%s refuses as captured', async (cmd) => {
    const { call } = await e1();
    expect(await call(cmd, { channel: 0 })).toEqual(read(`${cmd}.json`));
  });

  it('GetPtzPreset names are the captured pos1 … pos64, ids 0 … 63', async () => {
    const { call } = await e1();
    const file = read('GetPtzPreset.json');
    const reply = await call('GetPtzPreset', { channel: 0 });
    const strip = (l: any[]) => l.map(({ imgName: _i, ...rest }) => rest);
    expect(strip(reply.value.PtzPreset)).toEqual(strip(file.value.PtzPreset));
    expect(strip(reply.initial.PtzPreset)).toEqual(strip(file.initial.PtzPreset));
    expect(reply.value.PtzPreset.map((p: any) => p.name)).toEqual(Array.from({ length: 64 }, (_x, i) => `pos${i + 1}`));
  });

  it('GetZoomFocus at the start is the capture', async () => {
    const { call } = await e1();
    expect(await call('GetZoomFocus', { channel: 0 })).toEqual(read('GetZoomFocus.json'));
  });
});
