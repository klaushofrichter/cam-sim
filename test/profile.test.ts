import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FIRMWARE, devInfo, ENC, DEFAULT_NET_PORT, ABILITY, factorySettings, resetDefaults, IR_LIGHTS_EXTRA } from '../src/profile/rlc1224a';

const REF = join(__dirname, '..', 'reference', 'rlc-1224a');
const ref = (cmd: string) => JSON.parse(readFileSync(join(REF, `${cmd}.json`), 'utf8')).reply[0].value;

// Key sets, recursively: the simulator must answer with every key the camera sends.
function shape(o: unknown): unknown {
  if (Array.isArray(o)) return o.length ? [shape(o[0])] : [];
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape((o as any)[k])]));
  return typeof o;
}

describe('RLC-1224A profile', () => {
  it('has the measured identity', () => {
    const d = devInfo('Cam', 'SIMABC', FIRMWARE.firmVer);
    expect(d).toMatchObject({ model: 'RLC-1224A', firmVer: 'v3.2.0.6011_2607012059', hardVer: 'IPC_NT18NA612MP', serial: 'SIMABC', name: 'Cam' });
  });

  it('has streams, ports and abilities', () => {
    expect(ENC.mainStream.vType).toBe('h265');
    expect(ENC.subStream.size).toBe('896*512');
    expect(DEFAULT_NET_PORT).toMatchObject({ httpEnable: 1, httpsPort: 443, rtmpEnable: 1, onvifPort: 8000 });
    for (const k of ['rtsp', 'httpFlv', 'ftpSubStream']) expect(ABILITY.Ability).toHaveProperty(k);
    expect(IR_LIGHTS_EXTRA.range.IrLights.state).toEqual(['Auto', 'Off']);
  });

  it('factory settings use the OSD name and keep FTP off and empty', () => {
    const s = factorySettings('Porch');
    expect(s.Osd.osdChannel.name).toBe('Porch');
    expect(s.Ftp).toMatchObject({ enable: 0, server: '', userName: '', password: '', remoteDir: '' });
    expect(s.AiAlarm.vehicle.ai_type).toBe('vehicle');
    expect(s.Rec.schedule.table.MD).toBe('1'.repeat(168));
  });

  it('reset defaults match the measured partial-write resets', () => {
    const r = resetDefaults();
    expect(r.Isp.rotation).toBe(1);
    expect(r.Isp.mirroring).toBe(1);
    expect(r.Osd.watermark).toBe(0);
    expect(r.AiAlarm.people.stay_time).toBe(0);
    expect(r.Rec.schedule.table.MD).toBe('0'.repeat(168));
    expect(shape(r.Isp)).toEqual(shape(factorySettings('x').Isp));
  });

  it.skipIf(!existsSync(REF))('matches the key sets of the captured replies', () => {
    const f = factorySettings('Cam');
    // The real camera's keys, plus cam-sim's one intended extra (simulator).
    const { simulator, ...dev } = devInfo('Cam', 'S', FIRMWARE.firmVer) as Record<string, unknown>;
    expect(simulator).toMatch(/^cam-sim /);
    expect(shape(dev)).toEqual(shape(ref('GetDevInfo').DevInfo));
    expect(shape(ENC)).toEqual(shape(ref('GetEnc').Enc));
    expect(shape(DEFAULT_NET_PORT)).toEqual(shape(ref('GetNetPort').NetPort));
    expect(shape(f.Rec)).toEqual(shape(ref('GetRecV20').Rec));
    expect(shape(f.MdAlarm)).toEqual(shape(ref('GetMdAlarm').MdAlarm));
    expect(shape(f.AiAlarm.people)).toEqual(shape(ref('GetAiAlarm').AiAlarm));
    expect(shape(f.Isp)).toEqual(shape(ref('GetIsp').Isp));
    expect(shape(f.IrLights)).toEqual(shape(ref('GetIrLights').IrLights));
    expect(shape(f.WhiteLed)).toEqual(shape(ref('GetWhiteLed').WhiteLed));
    expect(shape(f.Osd)).toEqual(shape(ref('GetOsd').Osd));
    expect(shape(f.Ftp)).toEqual(shape(ref('GetFtpV20').Ftp));
    expect(f.Isp).toEqual(ref('GetIsp').Isp);
    expect(f.WhiteLed).toEqual(ref('GetWhiteLed').WhiteLed);
    expect(f.MdAlarm).toEqual(ref('GetMdAlarm').MdAlarm);
  });
});

describe('devInfo identifies the simulator (cams labels it, Klaus 2026-09-28)', () => {
  it('adds simulator: cam-sim and its version, and changes nothing else', () => {
    const d = devInfo('Den', 'SERIAL', 'v3.2.0.6011_2607012059') as Record<string, unknown>;
    // The build's APP_VERSION (the container), else dev (cams issue #69).
    expect(d.simulator).toBe(`cam-sim ${process.env.APP_VERSION || 'dev'}`);
    expect(d.model).toBe(FIRMWARE.model);
    expect(Object.keys(d)).toHaveLength(21); // the real camera's 20 keys + simulator
  });
});
