import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { spawn } from 'child_process';
import { makeEngine } from './helpers';
import { RtspService, findMediaMtx } from '../src/rtsp/rtsp';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Library } from '../src/media/library';

const run = promisify(execFile);
const mediamtx = findMediaMtx();
if (process.env.CI && !mediamtx) throw new Error('MediaMTX is required in CI (CAMSIM_MEDIAMTX)');

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

// ffprobe as an RTSP client: codec and size, or the error text.
async function probe(url: string): Promise<{ codec?: string; width?: number; error?: string }> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-rw_timeout', '5000000', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width', '-of', 'json', url], { timeout: 15_000 });
    const s = JSON.parse(stdout).streams[0];
    return { codec: s.codec_name, width: s.width };
  } catch (e) {
    return { error: String((e as { stderr?: string }).stderr ?? e) };
  }
}

const services: RtspService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
});

describe.skipIf(!mediamtx)('RTSP', () => {
  async function start() {
    const engine = await makeEngine();
    const port = await freePort();
    const svc = new RtspService(engine, { port, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    return { engine, svc, url: (path: string, user = 'cams', pw = 'cams-pw') => `rtsp://${user}:${pw}@127.0.0.1:${port}/${path}` };
  }

  it('serves the camera paths: sub is H.264, main is H.265', async () => {
    const { url } = await start();
    expect(await probe(url('h264Preview_01_sub'))).toMatchObject({ codec: 'h264', width: 896 });
    expect(await probe(url('h264Preview_01_main'))).toMatchObject({ codec: 'hevc' });
  }, 60_000);

  it('switches both paths to a newly selected video', async () => {
    const { engine, url } = await start();
    const src = mkdtempSync(join(tmpdir(), 'camsim-rtsp-src-'));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(src, 'a.mp4')]);
    engine.config.mainSize = '640x360';
    const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-rtsp-cache-')) });
    await lib.prepareAll();
    const before = await probe(url('h264Preview_01_main'));
    expect(before.width).not.toBe(640);
    expect(lib.select('a')).toBeNull();
    await expect.poll(async () => (await probe(url('h264Preview_01_main'))).width, { timeout: 20_000, interval: 1000 }).toBe(640);
  }, 90_000);

  it('requires a camera user', async () => {
    const { url } = await start();
    expect((await probe(url('h264Preview_01_sub', 'cams', 'wrong'))).error).toMatch(/401|Unauthorized|authoriz/i);
    expect((await probe(url('h264Preview_01_other'))).error).toBeDefined();
  }, 60_000);

  it('refuses while RTSP is off, the camera is offline, or rtsp.refuse is on', async () => {
    const { url, engine } = await start();
    engine.settings.running.NetPort.rtspEnable = 0;
    expect((await probe(url('h264Preview_01_sub'))).error).toBeDefined();
    engine.settings.running.NetPort.rtspEnable = 1;
    engine.faults.set({ name: 'rtsp.refuse' });
    expect((await probe(url('h264Preview_01_sub'))).error).toBeDefined();
    engine.faults.clear('rtsp.refuse');
    engine.faults.set({ name: 'offline' });
    expect((await probe(url('h264Preview_01_sub'))).error).toBeDefined();
    engine.faults.clear('offline');
    // Going offline cut the readers by restarting the publishers; they are back
    // about a second later.
    await expect.poll(async () => (await probe(url('h264Preview_01_sub'))).codec, { timeout: 20_000 }).toBe('h264');
  }, 90_000);
});

describe.skipIf(!mediamtx)('RTSP lifecycle', () => {
  it('fails to start, without looping, when the port is taken', async () => {
    const port = await freePort();
    const holder = net.createServer().listen(port, '127.0.0.1');
    await new Promise((r) => holder.once('listening', r));
    try {
      const engine = await makeEngine();
      const svc = new RtspService(engine, { port, host: '127.0.0.1', mediamtx: mediamtx! });
      services.push(svc);
      await expect(svc.start()).rejects.toThrow(/MediaMTX/);
      expect(svc.running()).toBe(false);
    } finally {
      holder.close();
    }
  }, 30_000);

  it('reports a binary that cannot run instead of crashing the process', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: await freePort(), host: '127.0.0.1', mediamtx: '/nonexistent/mediamtx' });
    services.push(svc);
    await expect(svc.start()).rejects.toThrow();
    expect(svc.running()).toBe(false);
  });

  it('notices MediaMTX dying and stops publishing', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: await freePort(), host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    process.kill(svc.pid()!, 'SIGKILL');
    await expect.poll(() => svc.running(), { timeout: 5000 }).toBe(false);
    await expect.poll(() => svc.publishing(), { timeout: 5000 }).toBe(0);
  }, 30_000);

  it('stop() during start() leaves no MediaMTX behind', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: await freePort(), host: '127.0.0.1', mediamtx: mediamtx! });
    const starting = svc.start().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    const pid = svc.pid();
    await svc.stop();
    await starting;
    expect(svc.running()).toBe(false);
    if (pid) expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it('port 0 picks a free port and reports it', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: 0, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    expect(svc.port()).toBeGreaterThan(0);
    expect(await probe(`rtsp://cams:cams-pw@127.0.0.1:${svc.port()}/h264Preview_01_sub`)).toMatchObject({ codec: 'h264' });
  }, 60_000);

  it('keeps connected readers under rtsp.refuse (only new readers are refused)', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: 0, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    const url = `rtsp://cams:cams-pw@127.0.0.1:${svc.port()}/h264Preview_01_sub`;
    const reader = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-f', 'null', '-']);
    let exited = false;
    reader.once('exit', () => { exited = true; });
    await new Promise((r) => setTimeout(r, 1500));
    engine.faults.set({ name: 'rtsp.refuse' });
    expect((await probe(url)).error).toBeDefined();
    await new Promise((r) => setTimeout(r, 3000));
    expect(exited).toBe(false);
    reader.kill('SIGKILL');
    await svc.stop();
  }, 60_000);

  it('cuts connected readers when the camera goes offline, and under rtsp.reset', async () => {
    for (const fault of ['offline', 'rtsp.reset'] as const) {
      const engine = await makeEngine();
      const svc = new RtspService(engine, { port: 0, host: '127.0.0.1', mediamtx: mediamtx! });
      services.push(svc);
      await svc.start();
      const reader = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://cams:cams-pw@127.0.0.1:${svc.port()}/h264Preview_01_sub`, '-f', 'null', '-']);
      const exited = new Promise((r) => reader.once('exit', r));
      await new Promise((r) => setTimeout(r, 1500));
      engine.faults.set({ name: fault });
      await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error(`reader not cut (${fault})`)), 15_000))]);
      await svc.stop();
    }
  }, 60_000);
});

describe('RTSP availability', () => {
  it('is skipped with a warning when MediaMTX is missing', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: await freePort(), host: '127.0.0.1', mediamtx: undefined });
    await svc.start();
    expect(svc.running()).toBe(false);
    await svc.stop();
  });
});
