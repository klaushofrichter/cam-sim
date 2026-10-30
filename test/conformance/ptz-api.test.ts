// The PTZ commands of pan/tilt models (the E1 Outdoor Pro), and the fixed
// models' unchanged answers.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fixedClock } from '../../src/engine/clock';
import { makeCamera, post, login } from '../helpers';

const REF = join(__dirname, '..', '..', 'reference', 'E1-Outdoor-Pro');
const entry = (cmd: string) => JSON.parse(readFileSync(join(REF, `${cmd}.json`), 'utf8'));
const OK200 = (cmd: string) => ({ cmd, code: 0, value: { rspCode: 200 } });
const PTZ_CMDS = [
  'PtzCtrl', 'StartZoomFocus', 'GetZoomFocus', 'GetPtzPreset', 'SetPtzPreset', 'GetPtzGuard', 'GetPtzCheckState',
  'GetAutoFocus', 'GetPtzPatrol', 'GetPtzCurPos', 'GetPtzTattern', 'GetPtzSerial', 'GetPtzTraceSection',
];

describe('PTZ commands (E1-Outdoor-Pro)', () => {
  let clock: ReturnType<typeof fixedClock>;
  let cam: Awaited<ReturnType<typeof makeCamera>>;
  let t: string;
  const e1 = () => makeCamera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' }, { clock });
  const call = async (cmd: string, param: unknown = {}) => (await post(cam.app, cmd, param, t)).reply;

  beforeEach(async () => {
    clock = fixedClock(new Date('2026-10-30T12:00:00Z'));
    cam = await e1();
    t = await login(cam.app);
  });

  it('PtzCtrl Left 32, 2 s, Stop → {rspCode:200}; the state shows pan 84', async () => {
    expect(await call('PtzCtrl', { channel: 0, op: 'Left', speed: 32 })).toEqual(OK200('PtzCtrl'));
    clock.advance(2000);
    expect(await call('PtzCtrl', { channel: 0, op: 'Stop' })).toEqual(OK200('PtzCtrl'));
    expect(cam.engine.ptz!.view()).toMatchObject({ pan: 84, tilt: 25, moving: null });
  });

  it('PtzCtrl speed 0 → param error -4', async () => {
    expect(await call('PtzCtrl', { channel: 0, op: 'Left', speed: 0 })).toEqual({ cmd: 'PtzCtrl', code: 1, error: { detail: 'param error', rspCode: -4 } });
    expect(await call('PtzCtrl', { channel: 0, op: 'Bogus', speed: 32 })).toEqual({ cmd: 'PtzCtrl', code: 1, error: { detail: 'param error', rspCode: -4 } });
  });

  it('GetZoomFocus: initial, range, value in the captured order; initial follows the position (measured)', async () => {
    const r = await call('GetZoomFocus', { channel: 0 });
    expect(Object.keys(r)).toEqual(['cmd', 'code', 'initial', 'range', 'value']);
    expect(r.value).toEqual({ ZoomFocus: { channel: 0, focus: { pos: 49 }, zoom: { pos: 7 } } });
    expect(r).toEqual(entry('GetZoomFocus'));
    await call('PtzCtrl', { channel: 0, op: 'ZoomInc', speed: 32 });
    clock.advance(1500);
    await call('PtzCtrl', { channel: 0, op: 'Stop' });
    const after = await call('GetZoomFocus', { channel: 0 });
    expect(after.value.ZoomFocus.zoom.pos).toBe(26);
    expect(after.initial).toEqual(after.value);
  });

  it('SetPtzPreset id 63 then GetPtzPreset shows enable 1 and the name; ToPos 63 restores zoom', async () => {
    await call('PtzCtrl', { channel: 0, op: 'ZoomInc', speed: 32 });
    clock.advance(1000);
    await call('PtzCtrl', { channel: 0, op: 'Stop' });
    expect(await call('SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 63, name: 'cams-test' } })).toEqual(OK200('SetPtzPreset'));
    const g = await call('GetPtzPreset', { channel: 0 });
    expect(Object.keys(g)).toEqual(['cmd', 'code', 'initial', 'range', 'value']);
    expect(g.range).toEqual(entry('GetPtzPreset').range);
    expect(g.value.PtzPreset).toHaveLength(64);
    expect(g.value.PtzPreset[63]).toEqual({ channel: 0, enable: 1, id: 63, imgName: '', name: 'cams-test' });
    expect(g.initial.PtzPreset[63]).toEqual({ channel: 0, enable: 0, id: 63, imgName: '', name: 'pos64' });
    expect(await call('StartZoomFocus', { ZoomFocus: { channel: 0, op: 'ZoomPos', pos: 7 } })).toEqual(OK200('StartZoomFocus'));
    expect(await call('PtzCtrl', { channel: 0, op: 'ToPos', id: 63, speed: 32 })).toEqual(OK200('PtzCtrl'));
    expect((await call('GetZoomFocus', { channel: 0 })).value.ZoomFocus.zoom.pos).toBe(20);
    expect(await call('SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 64, name: 'x' } })).toEqual({ cmd: 'SetPtzPreset', code: 1, error: { detail: 'param error', rspCode: -4 } });
  });

  it('StartZoomFocus ZoomPos 7 → 200; GetZoomFocus zoom 7; a bad pos → -4', async () => {
    await call('PtzCtrl', { channel: 0, op: 'ZoomInc', speed: 64 });
    clock.advance(1000);
    expect(await call('StartZoomFocus', { ZoomFocus: { channel: 0, op: 'ZoomPos', pos: 7 } })).toEqual(OK200('StartZoomFocus'));
    expect((await call('GetZoomFocus', { channel: 0 })).value.ZoomFocus.zoom.pos).toBe(7);
    expect(await call('StartZoomFocus', { ZoomFocus: { channel: 0, op: 'ZoomPos', pos: 28 } })).toEqual({ cmd: 'StartZoomFocus', code: 1, error: { detail: 'param error', rspCode: -4 } });
    expect((await call('StartZoomFocus', {})).code).toBe(1);
  });

  it('GetPtzGuard / GetPtzCheckState / GetAutoFocus / GetPtzPatrol answer the profile values', async () => {
    for (const cmd of ['GetPtzGuard', 'GetPtzCheckState', 'GetAutoFocus', 'GetPtzPatrol']) {
      const r = await call(cmd, { channel: 0 });
      const want = cam.engine.profile.ptz!.answers[cmd as 'GetPtzGuard'];
      expect(r).toEqual({ cmd, code: 0, ...want });
      expect(Object.keys(r)).toEqual(Object.keys(entry(cmd)));
    }
  });

  it('the refusals answer as captured: GetPtzCurPos -1 "not exist", GetPtzTattern -12 …', async () => {
    expect(await call('GetPtzCurPos', { channel: 0 })).toEqual({ cmd: 'GetPtzCurPos', code: 1, error: { detail: 'not exist', rspCode: -1 } });
    for (const cmd of ['GetPtzCurPos', 'GetPtzTattern', 'GetPtzSerial', 'GetPtzTraceSection']) {
      expect(await call(cmd, { channel: 0 })).toEqual(entry(cmd));
    }
  });

  it('settings.fail / settings.ignore with cmds ["SetPtzPreset"] apply; counters.setCalls lists SetPtzPreset', async () => {
    const set = (name: string) => call('SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 1, name } });
    cam.engine.faults.set({ name: 'settings.fail', cmds: ['SetPtzPreset'], count: 1 });
    expect(await set('a')).toEqual({ cmd: 'SetPtzPreset', code: 1, error: { detail: 'param error', rspCode: -67 } });
    cam.engine.faults.set({ name: 'settings.ignore', cmds: ['SetPtzPreset'], count: 1 });
    expect(await set('b')).toEqual(OK200('SetPtzPreset'));
    expect(cam.engine.ptz!.view().presets).toEqual([]);
    expect(await set('c')).toEqual(OK200('SetPtzPreset'));
    expect(cam.engine.ptz!.view().presets).toMatchObject([{ id: 1, name: 'c' }]);
    expect(cam.engine.counters.setCalls.filter((c) => c === 'SetPtzPreset')).toHaveLength(3);
  });

  it('reboot mid-move stops the move and keeps presets; reset({ptz:true}) clears both (review focus 3)', async () => {
    await call('SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 2, name: 'gate' } });
    await call('PtzCtrl', { channel: 0, op: 'Left', speed: 32 });
    clock.advance(1000);
    await cam.engine.reboot({ ms: 0 });
    clock.advance(1000);
    expect(cam.engine.ptz!.view()).toMatchObject({ pan: 132, moving: null, presets: [{ id: 2, name: 'gate' }] });
    expect(cam.engine.powerOff()).toBe(true);
    expect(await cam.engine.powerOn(0)).toBe(true);
    expect(cam.engine.ptz!.view().presets).toHaveLength(1);
    cam.engine.reset({ settings: true });
    expect(cam.engine.ptz!.view().presets).toHaveLength(1);
    cam.engine.reset({ ptz: true });
    expect(cam.engine.ptz!.view()).toEqual({ pan: 180, tilt: 25, zoom: 7, focus: 49, moving: null, presets: [] });
    t = await login(cam.app);
    await call('SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 2, name: 'gate' } });
    cam.engine.reset();
    expect(cam.engine.ptz!.view().presets).toEqual([]);
  });

  it('power-on mid-move also stops the move', async () => {
    await call('PtzCtrl', { channel: 0, op: 'Right', speed: 32 });
    clock.advance(1000);
    cam.engine.powerOff();
    await cam.engine.powerOn(0);
    clock.advance(1000);
    expect(cam.engine.ptz!.view()).toMatchObject({ pan: 228, moving: null });
  });

  it('two E1 engines move independently (review focus 5)', async () => {
    const other = await e1();
    const t2 = await login(other.app);
    await post(other.app, 'PtzCtrl', { channel: 0, op: 'Up', speed: 10 }, t2);
    await call('PtzCtrl', { channel: 0, op: 'Left', speed: 32 });
    clock.advance(1000);
    expect(cam.engine.ptz!.view()).toMatchObject({ pan: 132, tilt: 25 });
    expect(other.engine.ptz!.view()).toMatchObject({ pan: 180, tilt: 40 });
    expect(cam.engine.ptz).not.toBe(other.engine.ptz);
  });

  it('needs a login like every command', async () => {
    const r = (await post(cam.app, 'PtzCtrl', { channel: 0, op: 'Left', speed: 32 })).reply;
    expect(r.code).toBe(1);
    expect(cam.engine.ptz!.view().moving).toBeNull();
  });
});

describe.each(['RLC-1224A', 'CX820'])('%s', (model) => {
  it('every PTZ command answers the old Unknown -9 and engine.ptz is null (review focus 4)', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_MODEL: model });
    const t = await login(app);
    expect(engine.ptz).toBeNull();
    for (const cmd of PTZ_CMDS) {
      expect((await post(app, cmd, { channel: 0, op: 'Left', speed: 32 }, t)).reply).toEqual({ cmd: 'Unknown', code: 1, error: { detail: 'not support', rspCode: -9 } });
    }
    expect(engine.counters.setCalls).toEqual([]);
    engine.reset({ ptz: true });
  });
});
