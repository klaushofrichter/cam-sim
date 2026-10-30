import { describe, it, expect, beforeEach } from 'vitest';
import { fixedClock } from '../src/engine/clock';
import { Ptz, ptzEnabled, PTZ_OPS, type PtzSpec } from '../src/engine/ptz';

const SPEC: PtzSpec = {
  pan: [0, 355], tilt: [0, 50], zoom: [0, 27], focus: [0, 97],
  start: { pan: 180, tilt: 25, zoom: 7, focus: 49 },
  slots: 64, nameMax: 31, speed: [1, 64], defaultSpeed: 32,
  rate: { panTilt: 1.5, zoom: 0.4, focus: 0.4 },
  answers: {
    GetPtzGuard: { value: { PtzGuard: { timeout: 60 } } },
    GetPtzCheckState: { value: { PtzCheckState: 0 } },
    GetAutoFocus: { value: { AutoFocus: { disable: 0 } } },
    GetPtzPatrol: { value: { PtzPatrol: [] } },
  },
  zoomFocusRange: {}, presetRange: {},
  refusals: { GetPtzCurPos: { rspCode: -1, detail: 'not exist' } },
};

describe('Ptz', () => {
  let clock: ReturnType<typeof fixedClock>;
  let p: Ptz;
  beforeEach(() => {
    clock = fixedClock(new Date('2026-10-30T12:00:00Z'));
    p = new Ptz(SPEC, clock);
  });

  it('starts at the start position', () => {
    expect(p.position()).toEqual({ pan: 180, tilt: 25, zoom: 7, focus: 49 });
    expect(PTZ_OPS).toContain('ToPos');
  });

  it('Left at speed 32 for 2 s: pan 180 → 84; Stop freezes it', () => {
    expect(p.control({ op: 'Left', speed: 32 })).toBeNull();
    clock.advance(2000);
    expect(p.position().pan).toBe(84);
    expect(p.control({ op: 'Stop' })).toBeNull();
    clock.advance(5000);
    expect(p.position()).toEqual({ pan: 84, tilt: 25, zoom: 7, focus: 49 });
  });

  it('Right, Up, Down and the diagonals move their axes', () => {
    p.control({ op: 'Right', speed: 10 }); clock.advance(1000);
    expect(p.position().pan).toBe(195);
    p.control({ op: 'Down', speed: 10 }); clock.advance(1000);
    expect(p.position()).toMatchObject({ pan: 195, tilt: 10 });
    p.control({ op: 'RightUp', speed: 2 }); clock.advance(1000);
    expect(p.position()).toMatchObject({ pan: 198, tilt: 13 });
    p.control({ op: 'LeftDown', speed: 2 }); clock.advance(500);
    expect(p.position()).toMatchObject({ pan: 196.5, tilt: 11.5 });
    p.control({ op: 'LeftUp', speed: 2 }); clock.advance(1000);
    expect(p.position()).toMatchObject({ pan: 193.5, tilt: 14.5 });
    p.control({ op: 'RightDown', speed: 2 }); clock.advance(1000);
    expect(p.position()).toMatchObject({ pan: 196.5, tilt: 11.5 });
  });

  it('ZoomInc 32 for 1.5 s: zoom 7 → 26 (measured)', () => {
    p.control({ op: 'ZoomInc', speed: 32 });
    clock.advance(1500);
    p.control({ op: 'Stop' });
    expect(p.position().zoom).toBe(26);
  });

  it('FocusInc and FocusDec move the focus, ZoomDec the zoom', () => {
    p.control({ op: 'FocusInc', speed: 10 }); clock.advance(2500);
    expect(p.position().focus).toBe(59);
    p.control({ op: 'FocusDec', speed: 10 }); clock.advance(5000);
    expect(p.position().focus).toBe(39);
    p.control({ op: 'ZoomDec', speed: 10 }); clock.advance(1000);
    expect(p.position().zoom).toBe(3);
  });

  it('clamps at the end stops and stays finite (review focus 1)', () => {
    p.control({ op: 'Left', speed: 64 });
    clock.advance(60_000);
    expect(p.position().pan).toBe(0);
    p.control({ op: 'RightUp', speed: 64 });
    clock.advance(600_000);
    expect(p.position()).toMatchObject({ pan: 355, tilt: 50 });
    p.control({ op: 'ZoomInc', speed: 64 });
    clock.advance(600_000);
    expect(p.position().zoom).toBe(27);
    p.control({ op: 'FocusDec', speed: 64 });
    clock.advance(600_000);
    expect(p.position().focus).toBe(0);
    p.control({ op: 'ZoomDec', speed: 64 });
    clock.advance(600_000);
    const pos = p.position();
    expect(pos.zoom).toBe(0);
    for (const v of Object.values(pos)) expect(Number.isFinite(v)).toBe(true);
    // Held at a limit, the move is still running.
    expect(p.view().moving).toMatchObject({ op: 'ZoomDec', speed: 64 });
  });

  it('a clock that goes back never moves the other way', () => {
    p.control({ op: 'Left', speed: 32 });
    clock.advance(-5000);
    expect(p.position().pan).toBe(180);
  });

  it('a new op while moving settles the old one first (review focus 2)', () => {
    p.control({ op: 'Left', speed: 32 });
    clock.advance(1000);
    p.control({ op: 'Up', speed: 32 });
    clock.advance(1000);
    expect(p.position()).toMatchObject({ pan: 132, tilt: 50 });
    // Replacing a move by the same op restarts nothing: no double counting.
    p.control({ op: 'Down', speed: 32 });
    clock.advance(500);
    p.control({ op: 'Down', speed: 32 });
    clock.advance(500);
    expect(p.position()).toMatchObject({ pan: 132, tilt: 2 });
  });

  it('a zoom while a zoom runs → -13 and the running zoom continues (measured 2026-10-30)', () => {
    expect(p.control({ op: 'ZoomInc', speed: 32 })).toBeNull();
    clock.advance(500);
    expect(p.control({ op: 'ZoomInc', speed: 32 })).toBe(-13);
    expect(p.control({ op: 'ZoomDec', speed: 10 })).toBe(-13);
    expect(p.view().moving).toMatchObject({ op: 'ZoomInc', speed: 32 });
    clock.advance(1000);
    expect(p.control({ op: 'Stop' })).toBeNull();
    expect(p.position().zoom).toBe(26); // 1.5 s at 32, as without the refusals
    // Stop, then a zoom at once: accepted.
    expect(p.control({ op: 'ZoomDec', speed: 32 })).toBeNull();
    expect(p.view().moving).toMatchObject({ op: 'ZoomDec' });
  });

  it('moves and focus mid-motion, and a zoom after them, are accepted (measured 2026-10-30)', () => {
    for (const op of ['Left', 'Left', 'Right', 'Up', 'Down', 'LeftUp', 'RightDown', 'ZoomInc', 'Left', 'FocusInc', 'FocusInc', 'FocusDec', 'ZoomDec', 'FocusInc']) {
      clock.advance(100);
      expect(p.control({ op, speed: 32 }), op).toBeNull();
    }
  });

  it('speed: omitted ok; 1 and 64 ok; 0, 65, 100, 1.5, "32" → -4', () => {
    expect(p.control({ op: 'Right' })).toBeNull();
    clock.advance(1000);
    expect(p.position().pan).toBe(228); // default speed 32
    expect(p.control({ op: 'Left', speed: 1 })).toBeNull();
    expect(p.control({ op: 'Left', speed: 64 })).toBeNull();
    for (const speed of [0, 65, 100, 1.5, '32', null, -1]) expect(p.control({ op: 'Left', speed })).toBe(-4);
  });

  it('a refused command leaves the running move alone', () => {
    p.control({ op: 'Left', speed: 32 });
    clock.advance(1000);
    expect(p.control({ op: 'Up', speed: 0 })).toBe(-4);
    clock.advance(1000);
    expect(p.position()).toMatchObject({ pan: 84, tilt: 25 });
  });

  it('unknown op or missing op → -4; Stop always ok', () => {
    expect(p.control({ op: 'Bogus', speed: 32 })).toBe(-4);
    expect(p.control({})).toBe(-4);
    expect(p.control({ op: 7 })).toBe(-4);
    expect(p.control({ op: 'Stop' })).toBeNull();
    expect(p.control({ op: 'Stop', speed: 0 })).toBeNull();
    expect(p.control({ op: 'Stop', speed: 'x' })).toBeNull();
  });

  it('SetPtzPreset stores pan/tilt/zoom; ToPos goes there and ends a move', () => {
    p.control({ op: 'Left', speed: 32 }); clock.advance(1000);
    p.control({ op: 'ZoomInc', speed: 10 }); clock.advance(1000);
    p.control({ op: 'Stop' });
    expect(p.setPreset({ id: 5, enable: 1, name: 'gate' })).toBeNull();
    const saved = p.position();
    expect(saved).toMatchObject({ pan: 132, zoom: 11 });
    p.control({ op: 'Right', speed: 64 }); clock.advance(1000);
    p.control({ op: 'FocusInc', speed: 64 }); clock.advance(1000);
    expect(p.control({ op: 'ToPos', id: 5, speed: 32 })).toBeNull();
    clock.advance(1000);
    const now = p.position();
    expect(now).toMatchObject({ pan: 132, tilt: 25, zoom: 11 });
    // Focus is not part of a preset (the camera refocuses).
    expect(now.focus).not.toBe(saved.focus);
    expect(p.view().moving).toBeNull();
  });

  it('ToPos to an empty slot → null and nothing changes (measured)', () => {
    p.control({ op: 'Left', speed: 32 }); clock.advance(1000);
    p.control({ op: 'Stop' });
    const before = p.position();
    expect(p.control({ op: 'ToPos', id: 61, speed: 32 })).toBeNull();
    expect(p.position()).toEqual(before);
  });

  it('ids: 0..63 ok; 64, -1, "1", missing → -4 for SetPtzPreset and ToPos', () => {
    expect(p.setPreset({ id: 0, enable: 1, name: 'a' })).toBeNull();
    expect(p.setPreset({ id: 63, enable: 1, name: 'b' })).toBeNull();
    expect(p.control({ op: 'ToPos', id: 0 })).toBeNull();
    expect(p.control({ op: 'ToPos', id: 63 })).toBeNull();
    for (const id of [64, -1, '1', undefined, 1.5]) {
      expect(p.setPreset({ id, enable: 1, name: 'x' })).toBe(-4);
      expect(p.control({ op: 'ToPos', id, speed: 32 })).toBe(-4);
    }
    expect(p.control({ op: 'ToPos', id: 0, speed: 0 })).toBe(-4);
  });

  it('a 40-character name is stored as pos63 for id 62 (measured)', () => {
    expect(p.setPreset({ id: 62, enable: 1, name: 'x'.repeat(40) })).toBeNull();
    expect(p.presets()[62]).toEqual({ channel: 0, enable: 1, id: 62, imgName: '', name: 'pos63' });
    expect(p.setPreset({ id: 3, enable: 1, name: 'y'.repeat(31) })).toBeNull();
    expect(p.presets()[3].name).toBe('y'.repeat(31));
  });

  it('enable 1 with an empty or non-string name keeps the slot name', () => {
    p.setPreset({ id: 4, enable: 1, name: 'porch' });
    expect(p.setPreset({ id: 4, enable: 1, name: '' })).toBeNull();
    expect(p.presets()[4].name).toBe('porch');
    expect(p.setPreset({ id: 4, enable: 1 })).toBeNull();
    expect(p.presets()[4]).toMatchObject({ enable: 1, name: 'porch' });
  });

  it('enable 0 empties the slot; enable 2 → -4', () => {
    p.setPreset({ id: 10, enable: 1, name: 'drive' });
    expect(p.setPreset({ id: 10, enable: 0, name: '' })).toBeNull();
    expect(p.presets()[10]).toEqual({ channel: 0, enable: 0, id: 10, imgName: '', name: 'pos11' });
    expect(p.setPreset({ id: 10, enable: 2, name: 'x' })).toBe(-4);
    expect(p.setPreset({ id: 10, enable: '1', name: 'x' })).toBe(-4);
    expect(p.setPreset({ id: 10, name: 'x' })).toBe(-4);
    // An emptied slot is not a ToPos target any more.
    p.control({ op: 'Left', speed: 32 }); clock.advance(1000); p.control({ op: 'Stop' });
    p.control({ op: 'ToPos', id: 10 });
    expect(p.position().pan).toBe(132);
  });

  it('ZoomPos 7 sets zoom 7; FocusPos sets focus; ZoomPos 28 and op "Bogus" → -4', () => {
    p.control({ op: 'ZoomInc', speed: 32 }); clock.advance(1000);
    expect(p.zoomFocus({ op: 'ZoomPos', pos: 7 })).toBeNull();
    expect(p.position().zoom).toBe(7);
    expect(p.view().moving).toBeNull();
    expect(p.zoomFocus({ op: 'FocusPos', pos: 97 })).toBeNull();
    expect(p.position().focus).toBe(97);
    expect(p.zoomFocus({ op: 'ZoomPos', pos: 0 })).toBeNull();
    expect(p.position().zoom).toBe(0);
    for (const bad of [{ op: 'ZoomPos', pos: 28 }, { op: 'ZoomPos', pos: -1 }, { op: 'FocusPos', pos: 98 }, { op: 'ZoomPos', pos: 1.5 },
      { op: 'ZoomPos', pos: '7' }, { op: 'ZoomPos' }, { op: 'Bogus', pos: 7 }, {}]) {
      expect(p.zoomFocus(bad)).toBe(-4);
    }
    expect(p.position()).toMatchObject({ zoom: 0, focus: 97 });
  });

  it('presets() lists 64 entries id 0..63 named pos1..pos64, imgName ""', () => {
    const list = p.presets();
    expect(list).toHaveLength(64);
    list.forEach((e, i) => expect(e).toEqual({ channel: 0, enable: 0, id: i, imgName: '', name: `pos${i + 1}` }));
    expect(p.factoryPresets()).toEqual(list);
    p.setPreset({ id: 1, enable: 1, name: 'x' });
    expect(p.factoryPresets()[1]).toMatchObject({ enable: 0, name: 'pos2' });
  });

  it('view(): moving {op, speed, since ISO} while moving, null after Stop; presets only enabled', () => {
    expect(p.view()).toEqual({ pan: 180, tilt: 25, zoom: 7, focus: 49, moving: null, presets: [] });
    p.setPreset({ id: 9, enable: 1, name: 'b' });
    p.setPreset({ id: 2, enable: 1, name: 'a' });
    p.control({ op: 'Left' });
    clock.advance(1000);
    const v = p.view();
    expect(v.moving).toEqual({ op: 'Left', speed: 32, since: '2026-10-30T12:00:00.000Z' });
    expect(v.pan).toBe(132);
    expect(v.presets).toEqual([
      { id: 2, name: 'a', pan: 180, tilt: 25, zoom: 7 },
      { id: 9, name: 'b', pan: 180, tilt: 25, zoom: 7 },
    ]);
    p.control({ op: 'Stop' });
    expect(p.view().moving).toBeNull();
  });

  it('stop() settles and ends a move, keeping the presets', () => {
    p.setPreset({ id: 1, enable: 1, name: 'x' });
    p.control({ op: 'Left', speed: 32 }); clock.advance(1000);
    p.stop();
    clock.advance(1000);
    expect(p.position().pan).toBe(132);
    expect(p.view().moving).toBeNull();
    expect(p.view().presets).toHaveLength(1);
  });

  it('reset() back to start, all slots empty', () => {
    p.setPreset({ id: 1, enable: 1, name: 'x' });
    p.control({ op: 'Left', speed: 32 }); clock.advance(1000);
    p.reset();
    clock.advance(1000);
    expect(p.view()).toEqual({ pan: 180, tilt: 25, zoom: 7, focus: 49, moving: null, presets: [] });
    expect(p.presets()[1]).toMatchObject({ enable: 0, name: 'pos2' });
  });

  it('two instances move independently (review focus 5)', () => {
    const q = new Ptz(SPEC, clock);
    p.control({ op: 'Left', speed: 32 });
    clock.advance(1000);
    expect(q.position().pan).toBe(180);
    expect(p.position().pan).toBe(132);
  });

  it('ptzEnabled: permit 7 → true; permit 0 or missing → false', () => {
    const ab = (permit?: number) => ({ Ability: { abilityChn: [permit === undefined ? {} : { ptzCtrl: { permit, ver: 0 } }] } });
    expect(ptzEnabled(ab(7))).toBe(true);
    expect(ptzEnabled(ab(0))).toBe(false);
    expect(ptzEnabled(ab())).toBe(false);
    expect(ptzEnabled(undefined)).toBe(false);
    expect(ptzEnabled({})).toBe(false);
  });
});
