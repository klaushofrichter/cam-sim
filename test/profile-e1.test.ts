import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, ConfigError } from '../src/config';
import { configFromOptions } from '../src/index';
import { MODELS, profileFor } from '../src/profile/profile';
import { E1_OUTDOOR_PRO } from '../src/profile/E1-Outdoor-Pro';
import { ptzEnabled } from '../src/engine/ptz';
import { fixtureSpec } from '../src/media/fixtures';

// One reply entry per file (reference/E1-Outdoor-Pro/README.md).
const REF = join(__dirname, '..', 'reference', 'E1-Outdoor-Pro');
const entry = (cmd: string) => JSON.parse(readFileSync(join(REF, `${cmd}.json`), 'utf8'));
const ref = (cmd: string) => entry(cmd).value;
const E1 = profileFor('E1-Outdoor-Pro');

// Key sets, recursively (as in profile-cx820.test.ts).
function shape(o: unknown): unknown {
  if (Array.isArray(o)) return o.length ? [shape(o[0])] : [];
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape((o as any)[k])]));
  return typeof o;
}

describe('E1 Outdoor Pro model selection', () => {
  const base = { CAMSIM_USERS: 'a:admin:pw' };

  it('CAMSIM_MODEL=E1-Outdoor-Pro picks it, case-sensitively', () => {
    expect(MODELS).toEqual(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro']);
    expect(loadConfig({ ...base, CAMSIM_MODEL: 'E1-Outdoor-Pro' })).toMatchObject({ model: 'E1-Outdoor-Pro', firmVer: 'v3.1.0.5714_2511271366', mainSize: '3840x2160' });
    expect(() => loadConfig({ ...base, CAMSIM_MODEL: 'E1-OUTDOOR-PRO' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CAMSIM_MODEL: 'e1-outdoor-pro' })).toThrow(ConfigError);
    expect(configFromOptions({ users: [], model: 'E1-Outdoor-Pro' }).model).toBe('E1-Outdoor-Pro');
    expect(E1).toBe(E1_OUTDOOR_PRO);
  });
});

describe('E1 Outdoor Pro profile (reference/E1-Outdoor-Pro)', () => {
  it('DevInfo: the measured identity, the real key set plus simulator', () => {
    const { simulator, ...dev } = E1.devInfo('Cam', 'SIM000000000000', E1.firmware.firmVer) as Record<string, unknown>;
    expect(simulator).toMatch(/^cam-sim /);
    expect(dev).toEqual(ref('GetDevInfo').DevInfo);
    expect(dev).toMatchObject({ model: 'E1 Outdoor Pro', exactType: 'WIFI_SOLO_IPC', wifi: 1, itemNo: 'E560' });
  });

  it('the other models keep exactType IPC and wifi 0', () => {
    for (const m of ['RLC-1224A', 'CX820'] as const) {
      expect(profileFor(m).devInfo('Cam', 'S', 'v')).toMatchObject({ exactType: 'IPC', wifi: 0 });
    }
  });

  it('GetEnc, GetAbility and the media are the captured ones', () => {
    expect(E1.enc).toEqual(ref('GetEnc').Enc);
    expect(E1.ability).toEqual(ref('GetAbility'));
    expect(E1.media).toEqual({ sub: '640x360', subFps: 10, mainFps: 20, mainSize: '3840x2160' });
  });

  it('GetIrLights and GetWhiteLed extras are the captured initial/range', () => {
    for (const cmd of ['IrLights', 'WhiteLed'] as const) {
      const e = entry(`Get${cmd}`);
      expect(E1.extras[cmd]).toEqual({ initial: e.initial, range: e.range });
    }
  });

  it('factory settings are the captured values (name aside)', () => {
    const f = E1.factorySettings('Cam');
    expect(f.Isp).toEqual(ref('GetIsp').Isp);
    expect(f.WhiteLed).toEqual(ref('GetWhiteLed').WhiteLed);
    expect(f.IrLights).toEqual(ref('GetIrLights').IrLights);
    expect(f.Osd).toEqual(ref('GetOsd').Osd);
    expect(f.MdAlarm).toEqual(ref('GetMdAlarm').MdAlarm);
    expect(f.MdAlarm.scope).toMatchObject({ cols: 60, rows: 33 });
    for (const t of ['people', 'vehicle', 'dog_cat'] as const) expect(f.AiAlarm[t].scope).toMatchObject({ cols: 60, rows: 33 });
    expect(f.Ftp).toMatchObject({ picWidth: 3840, picHeight: 2160 });
    expect(E1.whiteLedModes).toContain(f.WhiteLed.mode);
    const r = E1.resetDefaults();
    expect(shape(r.Isp)).toEqual(shape(f.Isp));
    expect(shape(r.WhiteLed)).toEqual(shape(f.WhiteLed));
  });

  it('carries a PTZ spec with the measured limits', () => {
    expect(E1.ptz).toMatchObject({ zoom: [0, 27], focus: [0, 97], slots: 64, nameMax: 31, speed: [1, 64], start: { zoom: 7, focus: 49 } });
    expect(E1.ptz!.zoomFocusRange).toEqual(entry('GetZoomFocus').range);
    expect(E1.ptz!.presetRange).toEqual(entry('GetPtzPreset').range);
    expect(E1.ptz!.refusals).toEqual({
      GetPtzCurPos: { rspCode: -1, detail: 'not exist' },
      GetPtzTraceSection: { rspCode: -1, detail: 'not exist' },
      GetPtzTattern: { rspCode: -12, detail: 'get config failed' },
      GetPtzSerial: { rspCode: -12, detail: 'get config failed' },
    });
    for (const cmd of ['GetPtzGuard', 'GetPtzCheckState', 'GetAutoFocus', 'GetPtzPatrol'] as const) {
      const e = entry(cmd);
      expect(shape(E1.ptz!.answers[cmd])).toEqual(shape({ initial: e.initial, range: e.range, value: e.value }));
    }
    expect(JSON.stringify(E1.ptz)).not.toContain('redacted');
  });

  it('every model has a PTZ spec exactly when its ability grants ptzCtrl', () => {
    for (const m of MODELS) expect(!!profileFor(m).ptz).toBe(ptzEnabled(profileFor(m).ability));
    expect(ptzEnabled(E1.ability)).toBe(true);
  });

  it('test media: its own fixture folder', () => {
    expect(fixtureSpec(E1)).toEqual({ sub: '640x360', subFps: 10, mainFps: 20, suffix: '-e1-outdoor-pro' });
  });
});
