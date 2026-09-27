import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { makeEngine } from './helpers';
import { RtspService, findMediaMtx } from '../src/rtsp/rtsp';

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
    expect(await probe(url('h264Preview_01_sub'))).toMatchObject({ codec: 'h264' });
  }, 90_000);
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
