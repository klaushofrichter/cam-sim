// The virtual pan/tilt/zoom/focus state of a PTZ camera (the E1 Outdoor Pro,
// reference/E1-Outdoor-Pro/README.md). The camera reports no pan/tilt
// position, so pan and tilt are the simulator's own degrees; zoom and focus
// are the camera's steps. Moves advance lazily from the clock: position() is
// the state at clock.now(), so a fixed clock makes every test deterministic.
// No state at module level: every engine owns its own Ptz.
import type { Clock } from './clock';

export const PTZ_OPS = [
  'Left', 'Right', 'Up', 'Down', 'LeftUp', 'LeftDown', 'RightUp', 'RightDown',
  'Stop', 'ZoomInc', 'ZoomDec', 'FocusInc', 'FocusDec', 'ToPos',
] as const;
type Op = (typeof PTZ_OPS)[number];

type Range = readonly [number, number];
type Answer = { initial?: unknown; range?: unknown; value: unknown };

export interface PtzSpec {
  pan: Range; tilt: Range; zoom: Range; focus: Range; // sim units: pan/tilt degrees
  start: { pan: number; tilt: number; zoom: number; focus: number };
  slots: number; nameMax: number; speed: Range; defaultSpeed: number;
  rate: { panTilt: number; zoom: number; focus: number }; // units per second per speed unit
  // Autofocus: [zoom, focus] points, ascending zoom; the focus after a zoom
  // change is interpolated between them. Absent: focus stays through zooms.
  focusTrack?: ReadonlyArray<readonly [number, number]>;
  answers: { GetPtzGuard: Answer; GetPtzCheckState: Answer; GetAutoFocus: Answer; GetPtzPatrol: Answer };
  zoomFocusRange: unknown; presetRange: unknown; // GetZoomFocus / GetPtzPreset `range`
  refusals: Record<string, { rspCode: number; detail: string }>; // GetPtzCurPos, GetPtzTattern, ...
}

export interface PtzPos { pan: number; tilt: number; zoom: number; focus: number }

export interface PtzView extends PtzPos {
  moving: { op: string; speed: number; since: string } | null; // since: ISO time
  presets: Array<{ id: number; name: string; pan: number; tilt: number; zoom: number }>; // enabled only, by id
}

export interface PresetEntry { channel: 0; enable: 0 | 1; id: number; imgName: string; name: string }

// The PTZ commands exist when the ability grants ptzCtrl (the E1: permit 7;
// the RLC-1224A and CX820: 0).
export function ptzEnabled(ability: unknown): boolean {
  const permit = (ability as any)?.Ability?.abilityChn?.[0]?.ptzCtrl?.permit;
  return typeof permit === 'number' && permit > 0;
}

type Axis = keyof PtzPos;
const AXES: readonly Axis[] = ['pan', 'tilt', 'zoom', 'focus'];

// Direction per axis of each moving op. Up raises the tilt (not measured).
const DIRECTIONS: Partial<Record<Op, Partial<Record<Axis, 1 | -1>>>> = {
  Left: { pan: -1 }, Right: { pan: 1 }, Up: { tilt: 1 }, Down: { tilt: -1 },
  LeftUp: { pan: -1, tilt: 1 }, LeftDown: { pan: -1, tilt: -1 },
  RightUp: { pan: 1, tilt: 1 }, RightDown: { pan: 1, tilt: -1 },
  ZoomInc: { zoom: 1 }, ZoomDec: { zoom: -1 }, FocusInc: { focus: 1 }, FocusDec: { focus: -1 },
};

interface Slot { enable: 0 | 1; name: string; pan: number; tilt: number; zoom: number }
interface Move { op: Op; speed: number; sinceMs: number }

const PARAM_ERROR = -4;
const SET_CONFIG_FAILED = -13;
const isZoom = (op: string): boolean => op === 'ZoomInc' || op === 'ZoomDec';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const clamp = (v: number, [lo, hi]: Range): number => Math.min(hi, Math.max(lo, v));
const defaultName = (id: number): string => `pos${id + 1}`;

// The autofocus position for a zoom: linear between the track's points,
// held flat beyond its ends.
function trackFocus(track: ReadonlyArray<readonly [number, number]>, zoom: number): number {
  if (zoom <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i++) {
    const [z0, f0] = track[i - 1];
    const [z1, f1] = track[i];
    if (zoom <= z1) return f0 + ((f1 - f0) * (zoom - z0)) / (z1 - z0);
  }
  return track[track.length - 1][1];
}

export class Ptz {
  private base: PtzPos;
  private moving?: Move;
  private slots: Slot[] = [];

  constructor(private readonly spec: PtzSpec, private readonly clock: Clock) {
    this.base = { ...spec.start };
    this.reset();
  }

  // The (unrounded) position at `ms`: base plus the running move, clamped.
  private at(ms: number): PtzPos {
    const m = this.moving;
    if (!m) return { ...this.base };
    const secs = Math.max(0, ms - m.sinceMs) / 1000;
    const dir = DIRECTIONS[m.op] ?? {};
    const out = { ...this.base };
    for (const a of AXES) {
      const d = dir[a];
      if (!d) continue;
      const rate = a === 'zoom' ? this.spec.rate.zoom : a === 'focus' ? this.spec.rate.focus : this.spec.rate.panTilt;
      out[a] = clamp(this.base[a] + d * rate * m.speed * secs, this.spec[a]);
    }
    if (isZoom(m.op)) out.focus = this.refocus(out.zoom, out.focus);
    return out;
  }

  // The camera refocuses after every zoom change (autofocus on): focus
  // follows the zoom on the spec's track, or stays without one.
  private refocus(zoom: number, focus: number): number {
    const t = this.spec.focusTrack;
    return t?.length ? clamp(trackFocus(t, Math.round(zoom)), this.spec.focus) : focus;
  }

  // Ends the running move where it is now (every change starts here, so a
  // replaced move is counted once, up to the switch).
  private settle(): void {
    this.base = this.at(this.clock.now().getTime());
    this.moving = undefined;
  }

  // At clock.now(): pan/tilt to 0.1, zoom/focus whole steps.
  position(): PtzPos {
    const p = this.at(this.clock.now().getTime());
    return {
      pan: Math.round(p.pan * 10) / 10,
      tilt: Math.round(p.tilt * 10) / 10,
      zoom: Math.round(p.zoom),
      focus: Math.round(p.focus),
    };
  }

  private validId(id: unknown): id is number {
    return isInt(id) && id >= 0 && id < this.spec.slots;
  }

  // PtzCtrl: null for 200, else the rspCode. Omitted speed is the default
  // (not measured: 32); Stop ignores speed.
  control(p: { op?: unknown; speed?: unknown; id?: unknown }): number | null {
    const op = p.op;
    if (typeof op !== 'string' || !(PTZ_OPS as readonly string[]).includes(op)) return PARAM_ERROR;
    if (op === 'Stop') {
      this.settle();
      return null;
    }
    const [lo, hi] = this.spec.speed;
    const speed = p.speed === undefined ? this.spec.defaultSpeed : p.speed;
    if (!isInt(speed) || speed < lo || speed > hi) return PARAM_ERROR;
    if (op === 'ToPos') {
      if (!this.validId(p.id)) return PARAM_ERROR;
      const slot = this.slots[p.id];
      // An empty slot: 200 and no move (measured).
      if (!slot.enable) return null;
      // Applies at once (not measured); focus is not stored: the camera
      // refocuses for the slot's zoom (measured: zoom 20, focus 52 -> 77).
      this.settle();
      this.base = { ...this.base, pan: slot.pan, tilt: slot.tilt, zoom: slot.zoom, focus: this.refocus(slot.zoom, this.base.focus) };
      return null;
    }
    // A zoom while a zoom runs, either direction: -13 "set config failed",
    // and the running zoom goes on (measured 2026-10-30). Moves and focus may
    // be repeated or reversed mid-motion, and replace a zoom.
    if (isZoom(op) && this.moving && isZoom(this.moving.op)) return SET_CONFIG_FAILED;
    this.settle();
    this.moving = { op: op as Op, speed, sinceMs: this.clock.now().getTime() };
    return null;
  }

  // StartZoomFocus: ZoomPos (measured) or FocusPos (not measured), at once.
  zoomFocus(p: { op?: unknown; pos?: unknown }): number | null {
    const axis = p.op === 'ZoomPos' ? 'zoom' : p.op === 'FocusPos' ? 'focus' : undefined;
    if (!axis) return PARAM_ERROR;
    const [lo, hi] = this.spec[axis];
    if (!isInt(p.pos) || p.pos < lo || p.pos > hi) return PARAM_ERROR;
    this.settle();
    this.base = { ...this.base, [axis]: p.pos };
    // ZoomPos refocuses like any zoom (not measured).
    if (axis === 'zoom') this.base.focus = this.refocus(p.pos, this.base.focus);
    return null;
  }

  // SetPtzPreset: enable 1 saves the current pan/tilt/zoom; a name longer
  // than nameMax is stored as pos<id+1> (measured); an empty or missing name
  // keeps the slot's (not measured); one with a leading or trailing space or
  // two spaces in a row is ignored, slot unchanged (measured on the E1).
  // enable 0 empties the slot.
  setPreset(p: { id?: unknown; enable?: unknown; name?: unknown }): number | null {
    if (!this.validId(p.id)) return PARAM_ERROR;
    if (p.enable !== 0 && p.enable !== 1) return PARAM_ERROR;
    const id = p.id;
    if (p.enable === 0) {
      this.slots[id] = this.emptySlot(id);
      return null;
    }
    if (typeof p.name === 'string' && /^\s|\s$|\s\s/.test(p.name)) return null;
    const now = this.position();
    const old = this.slots[id];
    let name = old.name;
    if (typeof p.name === 'string' && p.name !== '') name = p.name.length > this.spec.nameMax ? defaultName(id) : p.name;
    this.slots[id] = { enable: 1, name, pan: now.pan, tilt: now.tilt, zoom: now.zoom };
    return null;
  }

  private emptySlot(id: number): Slot {
    const { pan, tilt, zoom } = this.spec.start;
    return { enable: 0, name: defaultName(id), pan, tilt, zoom };
  }

  presets(): PresetEntry[] {
    return this.slots.map((s, id) => ({ channel: 0, enable: s.enable, id, imgName: '', name: s.name }));
  }

  factoryPresets(): PresetEntry[] {
    return this.slots.map((_s, id) => ({ channel: 0, enable: 0, id, imgName: '', name: defaultName(id) }));
  }

  // Reboot and power-on: the move ends, the presets stay.
  stop(): void {
    this.settle();
  }

  // The start position, every slot empty.
  reset(): void {
    this.moving = undefined;
    this.base = { ...this.spec.start };
    this.slots = Array.from({ length: this.spec.slots }, (_x, id) => this.emptySlot(id));
  }

  view(): PtzView {
    const m = this.moving;
    return {
      ...this.position(),
      moving: m ? { op: m.op, speed: m.speed, since: new Date(m.sinceMs).toISOString() } : null,
      presets: this.slots.flatMap((s, id) => (s.enable ? [{ id, name: s.name, pan: s.pan, tilt: s.tilt, zoom: s.zoom }] : [])),
    };
  }
}
