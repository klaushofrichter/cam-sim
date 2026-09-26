import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Writable } from 'stream';
import { SettingsStore } from '../src/engine/settings';
import { createLogger } from '../src/log';

function logSink() {
  const lines: string[] = [];
  const dest = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
  return { log: createLogger('info', dest), lines };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camsim-settings-'));
});

const make = (file?: string) => new SettingsStore({ name: 'Den', file, log: logSink().log });
const ok = { strictPartial: false };

describe('SettingsStore', () => {
  it('a partial Set keeps the running value and resets the saved one', () => {
    const s = make();
    expect(s.set('SetIsp', { Isp: { channel: 0, dayNight: 'Color' } }, ok)).toBeNull();
    expect(s.running.Isp.dayNight).toBe('Color');
    expect(s.running.Isp.rotation).toBe(0);
    expect(s.saved.Isp.rotation).toBe(1);
    s.applySavedOnReboot();
    expect(s.running.Isp.rotation).toBe(1);
    expect(s.running.Isp.dayNight).toBe('Color');
  });

  it('strictPartial shows the reset at once', () => {
    const s = make();
    s.set('SetOsd', { Osd: { channel: 0, osdTime: { enable: 0, pos: 'Top Center' } } }, { strictPartial: true });
    expect(s.running.Osd.watermark).toBe(0);
    expect(s.running.Osd.osdChannel.name).toBe('');
  });

  it('a whole-object Set keeps every key', () => {
    const s = make();
    const isp = s.get('Isp') as any;
    isp.dayNight = 'Black&White';
    s.set('SetIsp', { Isp: isp }, ok);
    s.applySavedOnReboot();
    expect(s.running.Isp).toEqual(isp);
  });

  it('SetAiAlarm writes the object for its ai_type', () => {
    const s = make();
    const v = s.get('AiAlarm', 'vehicle') as any;
    s.set('SetAiAlarm', { AiAlarm: { ...v, sensitivity: 20 } }, ok);
    expect(s.running.AiAlarm.vehicle.sensitivity).toBe(20);
    expect(s.running.AiAlarm.people.sensitivity).toBe(60);
  });

  it('get returns a copy', () => {
    const s = make();
    (s.get('Isp') as any).dayNight = 'X';
    expect(s.running.Isp.dayNight).toBe('Auto');
  });

  const invalid: Array<[string, unknown, number]> = [
    ['SetMdAlarm', { MdAlarm: { newSens: { sensDef: 99 } } }, -56],
    ['SetMdAlarm', { MdAlarm: { newSens: { sensDef: 0 } } }, -56],
    ['SetAiAlarm', { AiAlarm: { ai_type: 'people', sensitivity: 101 } }, -56],
    ['SetAiAlarm', { AiAlarm: { ai_type: 'cat', sensitivity: 5 } }, -67],
    ['SetIsp', { Isp: { dayNight: 'Purple' } }, -67],
    ['SetIrLights', { IrLights: { state: 'On' } }, -67],
    ['SetWhiteLed', { WhiteLed: { mode: 4 } }, -67],
    ['SetWhiteLed', { WhiteLed: { bright: 101 } }, -56],
    ['SetOsd', { Osd: { osdTime: { pos: 'Middle' } } }, -67],
    ['SetOsd', { Osd: { osdChannel: { name: 'x'.repeat(32) } } }, -56],
    ['SetOsd', { Osd: { osdChannel: { name: 'a\u0007b' } } }, -56],
    ['SetFtpV20', { Ftp: { server: '' } }, -4],
  ];
  it.each(invalid)('%s %j → %i and nothing changes', (cmd, param, code) => {
    const s = make();
    const before = JSON.stringify(s.running);
    expect(s.set(cmd, param, ok)).toEqual({ rspCode: code });
    expect(JSON.stringify(s.running)).toBe(before);
  });

  it('ignores prototype keys', () => {
    const s = make();
    s.set('SetIsp', JSON.parse('{"Isp":{"dayNight":"Color","__proto__":{"polluted":1}}}'), ok);
    expect(({} as any).polluted).toBeUndefined();
    expect(s.running.Isp.dayNight).toBe('Color');
  });

  it('SetNetPort is a settings object too', () => {
    const s = make();
    const np = { ...(s.get('NetPort') as any), httpEnable: 0 };
    s.set('SetNetPort', { NetPort: np }, ok);
    expect(s.running.NetPort.httpEnable).toBe(0);
  });

  it('persists the saved state', () => {
    const f = join(dir, 'settings.json');
    const s = make(f);
    const isp = { ...(s.get('Isp') as any), dayNight: 'Color' };
    s.set('SetIsp', { Isp: isp }, ok);
    const again = make(f);
    expect(again.saved.Isp.dayNight).toBe('Color');
    expect(again.running.Isp.dayNight).toBe('Color');
    expect(JSON.parse(readFileSync(f, 'utf8')).Isp.dayNight).toBe('Color');
  });

  it('falls back to factory settings on a corrupt file', () => {
    const f = join(dir, 'settings.json');
    writeFileSync(f, '{"Isp": {"dayNi');
    const sink = logSink();
    const s = new SettingsStore({ name: 'Den', file: f, log: sink.log });
    expect(s.running.Osd.osdChannel.name).toBe('Den');
    expect(sink.lines.join('')).toContain('settings_file_invalid');
  });

  it('fills a well-formed but incomplete or wrong-shape file from factory settings', () => {
    for (const text of ['{}', '42', '{"NetPort":{"httpEnable":1},"Rec":"x"}']) {
      const f = join(dir, 'settings.json');
      writeFileSync(f, text);
      const sink = logSink();
      const s = new SettingsStore({ name: 'Den', file: f, log: sink.log });
      expect(s.running.Rec.enable).toBe(1);
      expect(s.running.AiAlarm.people.ai_type).toBe('people');
      expect(sink.lines.join('')).toContain('settings_file_invalid');
    }
  });

  it('keeps the valid parts of a partial file', () => {
    const f = join(dir, 'settings.json');
    writeFileSync(f, JSON.stringify({ Isp: { dayNight: 'Color' } }));
    const s = new SettingsStore({ name: 'Den', file: f, log: logSink().log });
    expect(s.running.Isp.dayNight).toBe('Color');
    expect(s.running.Isp.rotation).toBe(0);
  });

  it('a partial SetNetPort never switches the web ports off after a reboot', () => {
    const s = make();
    s.set('SetNetPort', { NetPort: { rtmpEnable: 0 } }, ok);
    s.applySavedOnReboot();
    expect(s.running.NetPort).toMatchObject({ httpEnable: 1, httpsEnable: 1, rtmpEnable: 0 });
  });

  it('resets to factory', () => {
    const s = make();
    s.set('SetIsp', { Isp: { dayNight: 'Color' } }, ok);
    s.resetFactory();
    expect(s.running.Isp.dayNight).toBe('Auto');
    expect(s.saved.Isp.rotation).toBe(0);
  });

  it('does not accept unknown commands', () => {
    expect(() => make().set('SetBogus', {}, ok)).toThrow();
  });
});
