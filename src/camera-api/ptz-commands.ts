// The PTZ commands of pan/tilt models (profile.ptz, engine.ptz): measured on
// the E1 Outdoor Pro (reference/E1-Outdoor-Pro/). runCommand() consults these
// only when the engine has a Ptz, so the fixed models never reach them.
import { ok, fail, type Ctx, type Entry, type Handler } from './commands';
import type { Engine } from '../engine/engine';

const done = (cmd: string, r: number | null): Entry => (r === null ? ok(cmd, { rspCode: 200 }) : fail(cmd, r));

const spec = (e: Engine) => e.profile.ptz!;
const ptz = (e: Engine) => e.ptz!;

// A Get that answers the profile's captured answer. The PTZ Gets answer with
// initial and range whatever the action (captured with action 1; action 0 is
// not measured).
const captured = (key: 'GetPtzGuard' | 'GetPtzCheckState' | 'GetAutoFocus' | 'GetPtzPatrol'): Handler => (c) => {
  const { initial, range, value } = spec(c.engine).answers[key];
  return ok(c.cmd, value, { initial, range });
};

export const PTZ_HANDLERS: Record<string, Handler> = {
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
  SetPtzPreset: (c) => {
    const e = c.engine;
    e.counters.noteSet(c.cmd);
    const failing = e.faults.consume('settings.fail', c.cmd);
    if (failing) return fail(c.cmd, failing.rspCode ?? -67);
    if (e.faults.consume('settings.ignore', c.cmd)) return ok(c.cmd, { rspCode: 200 });
    return done(c.cmd, ptz(e).setPreset(c.param?.PtzPreset ?? {}));
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
  const refusals = c.engine.profile.ptz?.refusals ?? {};
  if (!Object.hasOwn(refusals, c.cmd)) return undefined;
  const { rspCode, detail } = refusals[c.cmd];
  return (x) => ({ cmd: x.cmd, code: 1, error: { detail, rspCode } });
}
