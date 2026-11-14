// The PTZ commands of pan/tilt models (profile.ptz, engine.ptz): measured on
// the E1 Outdoor Pro (reference/E1-Outdoor-Pro/). runCommand() consults these
// only when the engine has a Ptz, so the fixed models never reach them.
import { ok, done, setFaults, type Ctx, type Entry, type Handler } from './commands';
import type { Engine } from '../engine/engine';

const spec = (e: Engine) => e.profile.ptz!;
const ptz = (e: Engine) => e.ptz!;

// A Get that answers the profile's captured answer. The PTZ Gets answer with
// initial and range whatever the action (captured with action 1; action 0 is
// not measured).
const captured = (key: 'GetPtzGuard' | 'GetPtzCheckState' | 'GetAutoFocus' | 'GetPtzPatrol'): Handler => (c) => {
  const { initial, range, value } = spec(c.engine).answers[key];
  return ok(c.cmd, value, { initial, range });
};

const PTZ_HANDLERS: Record<string, Handler> = {
  PtzCtrl: (c) => done(c.cmd, ptz(c.engine).control(c.param ?? {})),
  StartZoomFocus: (c) => done(c.cmd, ptz(c.engine).zoomFocus(c.param?.ZoomFocus ?? {})),
  // `initial` follows the current position (measured: it changed with the zoom).
  GetZoomFocus: (c) => {
    const p = ptz(c.engine).position();
    const value = { ZoomFocus: { channel: 0, focus: { pos: p.focus }, zoom: { pos: p.zoom } } };
    return ok(c.cmd, value, { initial: value, range: spec(c.engine).zoomFocusRange });
  },
  GetPtzPreset: (c) => ok(c.cmd, { PtzPreset: ptz(c.engine).presets() }, {
    initial: { PtzPreset: ptz(c.engine).factoryPresets() },
    range: spec(c.engine).presetRange,
  }),
  // Like a settings Set for the settings faults and setCalls; no `settings`
  // bus event (presets are not settings).
  SetPtzPreset: (c) => setFaults(c) ?? done(c.cmd, ptz(c.engine).setPreset(c.param?.PtzPreset ?? {})),
  // The position wrapped as {PtzCurPos: {channel}} (measured 2026-11-14); a
  // plain {channel} gets the captured refusal (-1 "not exist").
  GetPtzCurPos: (c) => {
    const w = c.param?.PtzCurPos;
    if (w === null || typeof w !== 'object' || Array.isArray(w)) return refusal(c);
    return ok(c.cmd, { PtzCurPos: ptz(c.engine).curPos() });
  },
  GetPtzGuard: captured('GetPtzGuard'),
  GetPtzCheckState: captured('GetPtzCheckState'),
  GetAutoFocus: captured('GetAutoFocus'),
  GetPtzPatrol: captured('GetPtzPatrol'),
};

// The handler for a PTZ model's command: one of the above, or a refusal the
// profile captured (GetPtzCurPos, GetPtzTattern, ...).
export function ptzHandler(c: Ctx): Handler | undefined {
  if (Object.hasOwn(PTZ_HANDLERS, c.cmd)) return PTZ_HANDLERS[c.cmd];
  if (!Object.hasOwn(c.engine.profile.ptz?.refusals ?? {}, c.cmd)) return undefined;
  return refusal;
}

// The refusal the profile captured for the command.
function refusal(c: Ctx): Entry {
  const { rspCode, detail } = spec(c.engine).refusals[c.cmd];
  return { cmd: c.cmd, code: 1, error: { detail, rspCode } };
}
