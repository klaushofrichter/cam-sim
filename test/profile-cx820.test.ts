import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { makeCamera, makeEngine, post, login } from './helpers';
import { loadConfig, ConfigError } from '../src/config';
import { configFromOptions } from '../src/index';
import { MODELS, profileFor } from '../src/profile/profile';
import { FIRMWARE_VERSION } from '../src/profile/version';
import { fileName, flagsHex } from '../src/engine/sdcard';
import { createControlApp } from '../src/control-api/app';
import { loginReplyXml, nonceXml } from '../src/baichuan/xml';
import { infoRecord } from '../src/baichuan/records';
import { decodeHeader } from '../src/baichuan/frame';
import { readTrace } from './baichuan/trace';
import { startBc, closeAll, DEMO } from './baichuan/harness';
import { timesOf } from '../src/baichuan/vod';
import { fixtureSpec } from '../src/media/fixtures';

afterEach(closeAll);

const REF = join(__dirname, '..', 'reference', 'cx820');
const TRACES = join(REF, 'baichuan');
const reply = (cmd: string) => JSON.parse(readFileSync(join(REF, `${cmd}.json`), 'utf8')).reply[0];
const ref = (cmd: string) => reply(cmd).value;
const CX = profileFor('CX820');
const camera = (file: string, cmd: number) => readTrace(file, TRACES).filter((m) => m.dir === 'out' && m.cmd === cmd);

// Key sets, recursively (as in profile.test.ts).
function shape(o: unknown): unknown {
  if (Array.isArray(o)) return o.length ? [shape(o[0])] : [];
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape((o as any)[k])]));
  return typeof o;
}

describe('model selection', () => {
  it('CAMSIM_MODEL picks the profile; RLC-1224A is the default; anything else is refused', () => {
    expect(MODELS).toEqual(['RLC-1224A', 'CX820']);
    const base = { CAMSIM_USERS: 'a:admin:pw' };
    expect(loadConfig(base).model).toBe('RLC-1224A');
    expect(loadConfig({ ...base, CAMSIM_MODEL: 'CX820' }).model).toBe('CX820');
    expect(() => loadConfig({ ...base, CAMSIM_MODEL: 'RLC-810A' })).toThrow(ConfigError);
    expect(configFromOptions({ users: [] }).model).toBe('RLC-1224A');
    expect(configFromOptions({ users: [], model: 'CX820' }).model).toBe('CX820');
  });

  it("the firmware and the converted main size default to the model's", () => {
    const base = { CAMSIM_USERS: 'a:admin:pw' };
    expect(loadConfig(base)).toMatchObject({ firmVer: FIRMWARE_VERSION, mainSize: '4512x2512' });
    expect(loadConfig({ ...base, CAMSIM_MODEL: 'CX820' })).toMatchObject({ firmVer: 'v3.2.0.5316_2509028854', mainSize: '3840x2160' });
    expect(loadConfig({ ...base, CAMSIM_MODEL: 'CX820', CAMSIM_FIRMWARE: 'v9', CAMSIM_MAIN_SIZE: '1280x720' })).toMatchObject({ firmVer: 'v9', mainSize: '1280x720' });
    expect(configFromOptions({ users: [], model: 'CX820' })).toMatchObject({ firmVer: 'v3.2.0.5316_2509028854', mainSize: '3840x2160' });
  });
});

describe('CX820 profile (reference/cx820)', () => {
  it('DevInfo: the measured identity, the real key set plus simulator', () => {
    const { simulator, ...dev } = CX.devInfo('Cam', 'SIM000000000000', CX.firmware.firmVer) as Record<string, unknown>;
    expect(simulator).toMatch(/^cam-sim /);
    expect(dev).toEqual(ref('GetDevInfo').DevInfo);
  });

  it('GetEnc and GetAbility are the captured ones', () => {
    expect(CX.enc).toEqual(ref('GetEnc').Enc);
    expect(CX.ability).toEqual(ref('GetAbility'));
  });

  it('factory settings are the captured values (the FTP upload and the ports as on a fresh camera)', () => {
    const f = CX.factorySettings('Cam');
    expect(f.Isp).toEqual(ref('GetIsp').Isp);
    expect(f.WhiteLed).toEqual(ref('GetWhiteLed').WhiteLed);
    expect(f.MdAlarm).toEqual(ref('GetMdAlarm').MdAlarm);
    expect(f.Rec).toEqual(ref('GetRecV20').Rec);
    expect(f.Osd).toEqual(ref('GetOsd').Osd);
    expect(f.IrLights).toEqual(ref('GetIrLights').IrLights);
    expect(f.Ntp).toEqual(ref('GetNtp').Ntp);
    expect(f.AiAlarm.people).toEqual(ref('GetAiAlarm').AiAlarm);
    expect(f.AiAlarm.vehicle).toEqual(ref('GetAiAlarm-vehicle').AiAlarm);
    expect(f.AiAlarm.dog_cat).toEqual(ref('GetAiAlarm-dog_cat').AiAlarm);
    expect(shape(f.Ftp)).toEqual(shape(ref('GetFtpV20').Ftp));
    expect(f.Ftp).toMatchObject({ enable: 0, server: '', userName: '', password: '', picWidth: 3840, picHeight: 2160 });
    expect(shape(f.NetPort)).toEqual(shape(ref('GetNetPort').NetPort));
    // Reset defaults keep the factory key sets (the partial-Set reset is not measured on the CX820).
    const r = CX.resetDefaults();
    expect(shape(r.Isp)).toEqual(shape(f.Isp));
    expect(shape(r.WhiteLed)).toEqual(shape(f.WhiteLed));
  });

  it('record file names carry the CX820 flags (Search-*.json)', () => {
    const sub = ref('Search-sub').SearchResult.File[0].name as string;
    const main = ref('Search-main').SearchResult.File[0].name as string;
    expect(flagsHex('sub', ['motion'], CX.fileFlags)).toBe('2B148080000000');
    expect(flagsHex('main', ['motion'], CX.fileFlags)).toBe('67328280000000');
    expect(fileName('sub', '2026-10-20', true, '110752', '110814', ['motion'], 0x6fe32, CX.fileFlags)).toBe(sub);
    expect(fileName('main', '2026-10-20', true, '110752', '110814', ['motion'], 0x4dd005, CX.fileFlags)).toBe(main);
    // The default stays the RLC-1224A's.
    expect(flagsHex('sub', ['motion'])).toBe('55148080000000');
  });

  it('test media follow the profile: sub 640x360 at 10 fps, main at 25 fps', () => {
    expect(fixtureSpec(profileFor('RLC-1224A'))).toEqual({ sub: '896x512', subFps: 10, mainFps: 20, suffix: '' });
    expect(fixtureSpec(CX)).toEqual({ sub: '640x360', subFps: 10, mainFps: 25, suffix: '-cx820' });
  });
});

describe('CX820 over HTTP', () => {
  const cx = () => makeCamera({ CAMSIM_MODEL: 'CX820', CAMSIM_NAME: 'Cam' });

  it('GetDevInfo, GetEnc and GetAbility answer as the CX820', async () => {
    const { app } = await cx();
    const t = await login(app);
    const dev = (await post(app, 'GetDevInfo', {}, t)).reply.value.DevInfo;
    expect(dev).toMatchObject({ model: 'CX820', firmVer: 'v3.2.0.5316_2509028854', hardVer: 'IPC_NT18NA68MP', itemNo: 'P335X', name: 'Cam' });
    expect((await post(app, 'GetEnc', { channel: 0 }, t)).reply.value.Enc).toEqual(ref('GetEnc').Enc);
    expect((await post(app, 'GetAbility', { User: { userName: 'cams' } }, t)).reply.value).toEqual(ref('GetAbility'));
  });

  it('GetUser has no CurUser (measured), the RLC-1224A keeps it', async () => {
    const { app } = await cx();
    const t = await login(app);
    const v = (await post(app, 'GetUser', {}, t)).reply.value;
    expect(Object.keys(v)).toEqual(Object.keys(ref('GetUser')));
    const rlc = await makeCamera();
    const v2 = (await post(rlc.app, 'GetUser', {}, await login(rlc.app))).reply.value;
    expect(v2.CurUser).toEqual({ User: 'cams' });
  });

  it('GetWhiteLed carries initial and range with action 0, like the camera', async () => {
    const { app } = await cx();
    const t = await login(app);
    const r = (await post(app, 'GetWhiteLed', { channel: 0 }, t)).reply;
    const want = reply('GetWhiteLed');
    expect(Object.keys(r)).toEqual(Object.keys(want));
    expect(r.initial).toEqual(want.initial);
    expect(r.range).toEqual(want.range);
    expect(r.value).toEqual(want.value);
  });

  it('a whole-object SetWhiteLed with the measured mode 5 is accepted', async () => {
    const { app } = await cx();
    const t = await login(app);
    const w = (await post(app, 'GetWhiteLed', { channel: 0 }, t)).reply.value.WhiteLed;
    expect((await post(app, 'SetWhiteLed', { WhiteLed: w }, t)).reply.code).toBe(0);
  });

  it('GetFtpV20 masks a 4-character user as c**4 and the password as 11 stars; a Set with the mask keeps the password', async () => {
    const { app, engine } = await cx();
    const t = await login(app);
    const ftp = (await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp;
    expect(ftp.password).toBe('');
    await post(app, 'SetFtpV20', { Ftp: { ...ftp, server: '127.0.0.1', userName: 'cam4', password: 'secret-pw' } }, t);
    const got = (await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp;
    expect(got.userName).toBe('c**4');
    expect(got.password).toBe(ref('GetFtpV20').Ftp.password);
    expect(got.password).toBe('*'.repeat(11));
    // A client writing the object back (whole-object Set) sends the mask.
    await post(app, 'SetFtpV20', { Ftp: { ...got, userName: 'cam4' } }, t);
    expect(engine.settings.get('Ftp').password).toBe('secret-pw');
    await post(app, 'SetFtpV20', { Ftp: { ...got, userName: 'camera' } }, t);
    expect((await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp.userName).toBe('ca**ra');
  });

  it('the RLC-1224A answers as before: the password as stored, a 4-character user unmasked', async () => {
    const { app } = await makeCamera();
    const t = await login(app);
    const ftp = (await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp;
    await post(app, 'SetFtpV20', { Ftp: { ...ftp, server: '127.0.0.1', userName: 'cam4', password: 'secret-pw' } }, t);
    const got = (await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp;
    expect(got).toMatchObject({ userName: 'cam4', password: 'secret-pw' });
  });

  it('the control API names the model and its streams', async () => {
    const engine = await makeEngine({ CAMSIM_MODEL: 'CX820', CAMSIM_CONTROL_TOKEN: 'tok' });
    const s = (await request(createControlApp(engine)).get('/sim/api/state').set('Authorization', 'Bearer tok')).body;
    expect(s).toMatchObject({ model: 'CX820', firmVer: 'v3.2.0.5316_2509028854' });
    expect(engine.state().model).toBe('CX820');
  });
});

describe('CX820 over Baichuan (reference/cx820/baichuan)', () => {
  it('the nonce reply offers sigV3 too: the traced XML and length', () => {
    const [m] = camera('login-proxy.txt', 1);
    expect(nonceXml('REDACTED', CX.baichuan.authTypes)).toBe(m.xml);
    expect(Buffer.byteLength(nonceXml('N'.repeat(29), CX.baichuan.authTypes))).toBe(decodeHeader(m.header).bodyLen);
  });

  it('the login reply: the traced XML and length (three StreamInfo, no videoEncTypeList)', () => {
    const m = camera('login-proxy.txt', 1)[1];
    expect(loginReplyXml('REDACTED', 'REDACTED', CX.baichuan.loginReplyLines)).toBe(m.xml);
    expect(Buffer.byteLength(loginReplyXml('A'.repeat(16), 'B'.repeat(16), CX.baichuan.loginReplyLines))).toBe(decodeHeader(m.header).bodyLen);
  });

  it('the eight pushes as traced, all soon after login', () => {
    const traced = readTrace('login-proxy.txt', TRACES).filter((m) => m.dir === 'out' && decodeHeader(m.header).msgId === 0);
    expect(CX.baichuan.pushes.map((p) => p.cmd)).toEqual(traced.map((m) => m.cmd));
    for (const p of CX.baichuan.pushes) {
      const m = traced.find((x) => x.cmd === p.cmd)!;
      expect(p.xml, `cmd ${p.cmd}`).toBe(m.xml);
      expect(p.trigger).toBe('afterLogin');
    }
  });

  it('the info record of the traced main file (vod-main.txt)', () => {
    const hex = /first cmd-8 reply payload: 32 B, hex: ([0-9a-f ]+)/.exec(readFileSync(join(TRACES, 'vod-main.txt'), 'utf8'))![1];
    const start = { year: 2026, month: 10, day: 20, hour: 11, minute: 7, second: 52 };
    const end = { ...start, minute: 8, second: 14 };
    const e = CX.enc.mainStream;
    expect(infoRecord({ width: e.width, height: e.height, fps: e.frameRate, main: true, start, end }).toString('hex')).toBe(hex.replace(/ /g, ''));
  });

  it('a session: the CX820 login reply, its pushes, and a download whose record has the CX820 sizes', async () => {
    const { engine, connect } = await startBc({ env: { CAMSIM_MODEL: 'CX820', ...DEMO } });
    const c = await connect();
    const r = await c.login('proxy', 'proxy-pw');
    expect(r.header.status).toBe(200);
    expect(c.text(r)).toContain('<resolutionName>3840*2160</resolutionName>');
    const floodlight = await c.waitFor((f) => f.header.cmd === 291 && f.header.msgId === 0, 3000);
    expect(c.text(floodlight)).not.toContain('brightness');
    const rec = engine.sd.all()[0];
    const { name, size } = rec.files.sub;
    expect(name).toContain('_2B14');
    const d = await c.download(name, size);
    expect(d.info).toEqual(infoRecord({ width: 640, height: 360, fps: 10, main: false, ...timesOf(rec, 'sub') }));
  });
});
