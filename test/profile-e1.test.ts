import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, ConfigError } from '../src/config';
import { configFromOptions } from '../src/index';
import { MODELS, profileFor } from '../src/profile/profile';
import { E1_OUTDOOR_PRO } from '../src/profile/E1-Outdoor-Pro';
import { Ptz, ptzEnabled } from '../src/engine/ptz';
import { fixedClock } from '../src/engine/clock';
import { fixtureSpec } from '../src/media/fixtures';
import { fileName, flagsHex, SdCard } from '../src/engine/sdcard';
import { createLogger } from '../src/log';

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
    // ext: assumed (the CX820's), not measured on the E1.
    expect(E1.media).toEqual({ sub: '640x360', subFps: 10, mainFps: 20, mainSize: '3840x2160', noSar: true, ext: { size: '896x512', fps: 15 } });
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

  it('autofocus: focus tracks zoom through the measured points (#114)', () => {
    const p = new Ptz(E1.ptz!, fixedClock(new Date('2026-10-30T12:00:00Z')));
    const at = (zoom: number) => (p.zoomFocus({ op: 'ZoomPos', pos: zoom }), p.position().focus);
    expect(at(7)).toBe(49);
    expect(at(26)).toBe(81);
    expect(at(20)).toBe(77);
    for (let z = 0; z <= 27; z++) {
      const f = at(z);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(97);
    }
  });

  it('every model has a PTZ spec exactly when its ability grants ptzCtrl', () => {
    for (const m of MODELS) expect(!!profileFor(m).ptz).toBe(ptzEnabled(profileFor(m).ability));
    expect(ptzEnabled(E1.ability)).toBe(true);
  });

  it('test media: its own fixture folder', () => {
    expect(fixtureSpec(E1)).toEqual({ sub: '640x360', subFps: 10, mainFps: 20, suffix: '-e1-outdoor-pro', noSar: true, ext: { size: '896x512', fps: 15 } });
  });
});

// Measured 2026-11-02 (read-only SD listings): the E1 writes name version 03,
// no animal-type field, 7 hex digits of flags; DST as on the other models.
describe('E1 Outdoor Pro record file names', () => {
  it('match the measured names: RecS03/RecM03, no 0_ field, 7-digit flags', () => {
    expect(flagsHex('sub', ['motion'], E1.fileFlags, E1.nameFormat?.flagDigits)).toBe('2B14808');
    expect(flagsHex('main', ['motion'], E1.fileFlags, E1.nameFormat?.flagDigits)).toBe('6728828');
    expect(fileName('sub', '2026-11-02', false, '065854', '065924', ['motion'], 0xb2b5f, E1.fileFlags, E1.nameFormat)).toBe('/mnt/sda/Mp4Record/2026-11-02/RecS03_20261102_065854_065924_2B14808_B2B5F.mp4');
    expect(fileName('main', '2026-11-02', false, '065854', '065924', ['motion'], 0x5d5561, E1.fileFlags, E1.nameFormat)).toBe('/mnt/sda/Mp4Record/2026-11-02/RecM03_20261102_065854_065924_6728828_5D5561.mp4');
    expect(fileName('sub', '2026-10-30', true, '080922', '080959', ['motion'], 0xc7076, E1.fileFlags, E1.nameFormat)).toBe('/mnt/sda/Mp4Record/2026-10-30/RecS03_DST20261030_080922_080959_2B14808_C7076.mp4');
  });

  it('trigger bits sit at the same positions from the top as in the 14-digit names', () => {
    // person 17, vehicle 19, pet 20, motion 24: bit 27 - pos (not measured on the E1).
    expect(flagsHex('sub', ['person', 'motion'], E1.fileFlags, 7)).toBe('2B14C08');
    expect(flagsHex('sub', ['pet'], E1.fileFlags, 7)).toBe('2B14880');
  });

  it('the SD card names its recordings that way, and the other models keep theirs', () => {
    const clock = fixedClock(new Date('2026-11-02T13:00:00Z'));
    const card = (p = E1) => new SdCard({ capacityMb: 1000, clock, tz: 'America/Chicago', log: createLogger('silent'), fixtureSizes: { sub: 0xb2b5f, main: 0x5d5561 }, fileFlags: p.fileFlags, nameFormat: p.nameFormat });
    const e1 = card();
    e1.seed([{ daysAgo: 0, start: '065854', end: '065924', triggers: ['motion'] }]);
    const f = e1.all()[0].files;
    expect(f.sub.name).toBe('/mnt/sda/Mp4Record/2026-11-02/RecS03_20261102_065854_065924_2B14808_B2B5F.mp4');
    expect(f.main.name).toMatch(/\/RecM03_20261102_065854_\d{6}_6728828_5D5561\.mp4$/);
    const cx = card(profileFor('CX820'));
    cx.seed([{ daysAgo: 0, start: '065949', end: '070025', triggers: ['motion'] }]);
    expect(cx.all()[0].files.sub.name).toBe('/mnt/sda/Mp4Record/2026-11-02/RecS0A_20261102_065949_070025_0_2B148080000000_B2B5F.mp4');
    const rlc = card(profileFor('RLC-1224A'));
    rlc.seed([{ daysAgo: 0, start: '061036', end: '061057', triggers: ['motion'] }]);
    expect(rlc.all()[0].files.sub.name).toBe('/mnt/sda/Mp4Record/2026-11-02/RecS0A_20261102_061036_061057_0_55148080000000_B2B5F.mp4');
  });
});
