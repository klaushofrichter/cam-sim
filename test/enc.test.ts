// GetEnc with action 1 (initial and range) and SetEnc: the running streams
// change, within the model's range; RTSP, Snap and the SD pipeline follow.
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createEngine } from '../src/engine/engine';
import { createCameraApp } from '../src/camera-api/app';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/log';
import { RtspService, findMediaMtx } from '../src/rtsp/rtsp';
import { E1_ENC_RANGE } from '../src/profile/enc';
import { profileFor } from '../src/profile/profile';
import { ENC as RLC_ENC } from '../src/profile/rlc1224a';
import { USERS, login, makeCamera } from './helpers';
import e1GetEnc from '../reference/E1-Outdoor-Pro/GetEnc.json';
import rlcProxy from '../reference/rlc-1224a/GetEnc-range-proxy.json';
import cx820Proxy from '../reference/cx820/GetEnc-range-proxy.json';

const run = promisify(execFile);
const mediamtx = findMediaMtx();

type App = Parameters<typeof request>[0];
async function cmd(app: App, t: string, name: string, param: unknown = {}, action = 0) {
  const res = await request(app).post(`/cgi-bin/api.cgi?cmd=${name}&token=${t}`).send([{ cmd: name, action, param }]);
  return JSON.parse(res.text)[0];
}

// A test range for the RLC-1224A: its own pair, plus the same main with a
// small sub (320x180) that encodes quickly.
function tinyRange() {
  const own = structuredClone(profileFor('RLC-1224A').encRange[0]);
  const small = structuredClone(own);
  Object.assign(small.subStream, { size: '320*180', width: 320, height: 180 });
  return [own, small];
}

// The restart after SetEnc is off unless a test asks for it (CAMSIM_ENC_RESTART_MS).
async function camera(env: Record<string, string> = {}, encRange?: Array<Record<string, any>>) {
  const config = loadConfig({ CAMSIM_USERS: USERS, CAMSIM_SEED: '1', CAMSIM_ENC_RESTART_MS: '0', ...env });
  const engine = await createEngine({ ...config, ...(encRange ? { encRange } : {}) }, { log: createLogger('silent') });
  const app = createCameraApp(engine, { port: 'http' });
  return { engine, app, t: await login(app) };
}

describe('GetEnc', () => {
  it('action 0 answers the value only', async () => {
    const { app } = await makeCamera();
    const t = await login(app);
    const r = await cmd(app, t, 'GetEnc', { channel: 0 });
    expect(r.code).toBe(0);
    expect(r.value.Enc).toEqual(RLC_ENC);
    expect(r).not.toHaveProperty('range');
  });

  it('action 1 on the E1 Outdoor Pro answers initial, range and value as captured', async () => {
    const { app, t } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' });
    const r = await cmd(app, t, 'GetEnc', { channel: 0 }, 1);
    expect(Object.keys(r)).toEqual(['cmd', 'code', 'initial', 'range', 'value']);
    expect(r.initial).toEqual(e1GetEnc.initial);
    expect(r.range).toEqual(e1GetEnc.range);
    expect(r.value).toEqual(e1GetEnc.value);
  });

  // The proxy's GET /settings/encoding on the real cameras, 2026-11-02
  // (reference/<model>/GetEnc-range-proxy.json): the range is that answer's
  // options in the camera's own form.
  it.each([['RLC-1224A', rlcProxy], ['CX820', cx820Proxy]] as const)('action 1 on the %s answers the range measured through the proxy', async (model, proxy) => {
    const { app, t } = await camera({ CAMSIM_MODEL: model });
    const r = await cmd(app, t, 'GetEnc', { channel: 0 }, 1);
    const asProxy = (s: any) => ({ width: s.width, height: s.height, codecs: s.vType, fps: s.frameRate, bitRates: s.bitRate, profiles: s.profile, gop: { min: s.gop.min, max: s.gop.max } });
    expect(r.range.Enc.map((e: any) => ({ main: asProxy(e.mainStream), sub: asProxy(e.subStream) }))).toEqual(proxy.options);
    for (const e of r.range.Enc) for (const k of ['mainStream', 'subStream'] as const) expect(e[k].size).toBe(`${e[k].width}*${e[k].height}`);
    expect(r.value.Enc.mainStream).toMatchObject({ width: proxy.main.width, height: proxy.main.height, vType: proxy.main.codec, frameRate: proxy.main.fps, bitRate: proxy.main.bitRate });
    expect(r.value.Enc.subStream).toMatchObject({ width: proxy.sub.width, height: proxy.sub.height, vType: proxy.sub.codec, frameRate: proxy.sub.fps, bitRate: proxy.sub.bitRate });
  });

  it('the RLC-1224A offers 4512x2512, 3840x2160, 2560x1440 and 2304x1296 in H.264 or H.265, the sub fixed at 896x512', () => {
    const r = profileFor('RLC-1224A').encRange;
    expect(r.map((e) => e.mainStream.size)).toEqual(['4512*2512', '3840*2160', '2560*1440', '2304*1296']);
    for (const e of r) expect([e.mainStream.vType, e.subStream.size]).toEqual([['h265', 'h264'], '896*512']);
  });

  it('the CX820 offers 3840x2160 in H.265 only, 2560x1440 and 2304x1296 in H.264 only, the sub fixed at 640x360', () => {
    const r = profileFor('CX820').encRange;
    expect(r.map((e) => [e.mainStream.size, e.mainStream.vType])).toEqual([['3840*2160', ['h265']], ['2560*1440', ['h264']], ['2304*1296', ['h264']]]);
    for (const e of r) expect(e.subStream.size).toBe('640*360');
  });
});

describe('SetEnc', () => {
  it('changes the running streams (whole object); width and height follow size', async () => {
    const { app, t, engine } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' });
    const enc = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    enc.mainStream = { ...enc.mainStream, size: '2560*1440', frameRate: 25, bitRate: 3072 };
    expect((await cmd(app, t, 'SetEnc', { Enc: enc })).value).toEqual({ rspCode: 200 });
    const after = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    expect(after.mainStream).toEqual({ ...enc.mainStream, width: 2560, height: 1440 });
    expect(after.subStream).toEqual(enc.subStream);
    expect(engine.counters.setCalls).toContain('SetEnc');
  });

  it.each([
    ['a sub size the camera does not offer', (e: any) => (e.subStream.size = '896*512')],
    ['a frame rate not in the list', (e: any) => (e.subStream.frameRate = 12)],
    ['a bit rate not in the list', (e: any) => (e.mainStream.bitRate = 9999)],
    ['an H.265 sub', (e: any) => (e.subStream.vType = 'h265')],
    ['a GOP out of range', (e: any) => (e.mainStream.gop = 9)],
  ])('refuses %s with -4 and changes nothing', async (_what, change) => {
    const { app, t } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' });
    const before = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    const enc = structuredClone(before);
    change(enc);
    const r = await cmd(app, t, 'SetEnc', { Enc: enc });
    expect([r.code, r.error.rspCode]).toEqual([1, -4]);
    expect((await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc).toEqual(before);
  });

  // Measured 2026-11-02 on the RLC-1224A, CX820 and E1 Outdoor Pro: after a
  // SetEnc that changes the streams the camera restarts (offline, then back
  // with the new settings; 40–75 s in all, 11 of 11 changes).
  it('restarts after a SetEnc that changes the streams: offline, then back with the new streams', async () => {
    const { app, t, engine } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro', CAMSIM_ENC_RESTART_MS: '400' });
    const enc = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    enc.mainStream = { ...enc.mainStream, size: '2560*1440', frameRate: 25, bitRate: 3072 };
    const states: unknown[] = [];
    engine.bus.on('state', (s) => states.push(s));
    expect((await cmd(app, t, 'SetEnc', { Enc: enc })).value).toEqual({ rspCode: 200 });
    await expect.poll(() => engine.down(), { timeout: 2000, interval: 20 }).toBe(true);
    expect(states).toContainEqual({ rebooting: true });
    await expect.poll(() => engine.down(), { timeout: 3000, interval: 20 }).toBe(false);
    // Sessions end with the restart: a new login sees the new streams.
    const t2 = await login(app);
    expect((await cmd(app, t2, 'GetEnc', { channel: 0 })).value.Enc.mainStream).toMatchObject({ width: 2560, height: 1440, frameRate: 25 });
  });

  it('does not restart after a SetEnc that changes nothing, or one it refuses', async () => {
    const { app, t, engine } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro', CAMSIM_ENC_RESTART_MS: '400' });
    const enc = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    expect((await cmd(app, t, 'SetEnc', { Enc: enc })).value).toEqual({ rspCode: 200 });
    const bad = structuredClone(enc);
    bad.subStream.size = '896*512';
    expect((await cmd(app, t, 'SetEnc', { Enc: bad })).error.rspCode).toBe(-4);
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.down()).toBe(false);
    expect(engine.counters.reboots).toBe(0);
  });

  it('the restart takes CAMSIM_ENC_RESTART_MS (default: 60 s at real speed, 1 s fast; 0: no restart)', async () => {
    expect(loadConfig({ CAMSIM_USERS: USERS }).encRestartMs).toBeUndefined();
    expect(loadConfig({ CAMSIM_USERS: USERS, CAMSIM_ENC_RESTART_MS: '45000' }).encRestartMs).toBe(45000);
    expect(() => loadConfig({ CAMSIM_USERS: USERS, CAMSIM_ENC_RESTART_MS: 'x' })).toThrow(/CAMSIM_ENC_RESTART_MS/);
    const real = await createEngine(loadConfig({ CAMSIM_USERS: USERS, CAMSIM_SPEED: 'real' }), { log: createLogger('silent') });
    const fast = await createEngine(loadConfig({ CAMSIM_USERS: USERS }), { log: createLogger('silent') });
    expect([real.encRestartMs, fast.encRestartMs]).toEqual([60_000, 1_000]);
    const { app, t, engine } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' });
    expect(engine.encRestartMs).toBe(0);
    const enc = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    enc.mainStream = { ...enc.mainStream, size: '2304*1296', frameRate: 15, bitRate: 2560 };
    await cmd(app, t, 'SetEnc', { Enc: enc });
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.down()).toBe(false);
  });

  it('Snap follows the main size', async () => {
    const { app, t, engine } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' });
    const enc = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    enc.mainStream = { ...enc.mainStream, size: '2304*1296', frameRate: 15, bitRate: 2560 };
    await cmd(app, t, 'SetEnc', { Enc: enc });
    const jpeg = await engine.snapMain();
    const f = join(mkdtempSync(join(tmpdir(), 'camsim-snap-')), 's.jpg');
    writeFileSync(f, jpeg);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' });
    expect(stdout.trim()).toBe('2304,1296');
  });
});

describe('the E1 sub stream as the camera codes it', () => {
  it('640x368 cropped to 640x360 (frame_crop_bottom_offset 4), no aspect_ratio_info', async () => {
    const { engine } = await camera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' });
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', engine.media.clipPath('sub'), '-map', '0:v', '-frames:v', '1', '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const field = (name: string) => Number(new RegExp(`${name}\\s+[01]+ = (\\d+)`).exec(stderr)?.[1]);
    expect((field('pic_width_in_mbs_minus1') + 1) * 16).toBe(640);
    expect((field('pic_height_in_map_units_minus1') + 1) * 16).toBe(368);
    expect(field('frame_crop_bottom_offset')).toBe(4);
    expect(field('aspect_ratio_info_present_flag')).toBe(0);
  }, 60_000);
});

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

async function probe(url: string): Promise<{ codec?: string; width?: number; height?: number; error?: string }> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-rw_timeout', '5000000', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height', '-of', 'json', url], { timeout: 15_000 });
    const s = JSON.parse(stdout).streams[0];
    return { codec: s.codec_name, width: s.width, height: s.height };
  } catch (e) {
    return { error: String((e as { stderr?: string }).stderr ?? e) };
  }
}

const services: RtspService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
});

describe.skipIf(!mediamtx)('SetEnc and RTSP', () => {
  it('the sub stream restarts at the new size, and back to the prepared copy', async () => {
    const { app, t, engine } = await camera({}, tinyRange());
    const port = await freePort();
    const svc = new RtspService(engine, { port, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    const url = `rtsp://cams:cams-pw@127.0.0.1:${port}/h264Preview_01_sub`;
    expect(await probe(url)).toMatchObject({ codec: 'h264', width: 896, height: 512 });
    const enc = (await cmd(app, t, 'GetEnc', { channel: 0 })).value.Enc;
    const small = structuredClone(enc);
    small.subStream.size = '320*180';
    expect((await cmd(app, t, 'SetEnc', { Enc: small })).code).toBe(0);
    await expect.poll(async () => (await probe(url)).width, { timeout: 20_000, interval: 1000 }).toBe(320);
    expect(await probe(url)).toMatchObject({ codec: 'h264', height: 180 });
    expect((await cmd(app, t, 'SetEnc', { Enc: enc })).code).toBe(0);
    await expect.poll(async () => (await probe(url)).width, { timeout: 20_000, interval: 1000 }).toBe(896);
  }, 90_000);
});
