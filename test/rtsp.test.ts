import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { spawn } from 'child_process';
import { makeEngine } from './helpers';
import { RtspService, findMediaMtx } from '../src/rtsp/rtsp';
import { mkdtempSync } from 'fs';
import { tmpdir, networkInterfaces } from 'os';
import { join } from 'path';
import { Library } from '../src/media/library';
import { SdPipeline } from '../src/pipeline/sd-pipeline';
import { findFonts } from '../src/pipeline/fonts';
import type { SequenceMedia } from '../src/media/sequence';

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

// One raw DESCRIBE (no sign-in): the status line and headers that come back.
function describe404(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`DESCRIBE rtsp://127.0.0.1:${port}/${path} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n`));
    let got = '';
    s.on('data', (d) => {
      got += d.toString('latin1');
      if (got.includes('\r\n\r\n')) (s.destroy(), resolve(got));
    });
    s.on('error', reject);
    setTimeout(() => (s.destroy(), resolve(got)), 5000).unref();
  });
}

const services: RtspService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
});

describe.skipIf(!mediamtx)('RTSP', () => {
  async function start(env: Record<string, string> = {}) {
    const engine = await makeEngine(env);
    const port = await freePort();
    const svc = new RtspService(engine, { port, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    return { engine, svc, port, url: (path: string, user = 'cams', pw = 'cams-pw') => `rtsp://${user}:${pw}@127.0.0.1:${port}/${path}` };
  }

  // cam-sim#92: bound to a non-loopback address, the stream must play there
  // (MediaMTX and its publishers stay on loopback behind the front).
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  it.skipIf(!lan)('plays on a non-loopback bind address (#92)', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: 0, host: lan, mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    expect(await probe(`rtsp://cams:cams-pw@${lan}:${svc.port()}/h264Preview_01_sub`)).toMatchObject({ codec: 'h264', width: 896 });
  }, 60_000);

  it('serves the camera paths: sub is H.264, main is H.265', async () => {
    const { url } = await start();
    expect(await probe(url('h264Preview_01_sub'))).toMatchObject({ codec: 'h264', width: 896 });
    expect(await probe(url('h264Preview_01_main'))).toMatchObject({ codec: 'hevc' });
  }, 60_000);

  // Measured on the CX820 (2026-11-03): its ext stream is FLV only; every
  // RTSP ext path answers DESCRIBE with 404 Stream Not Found.
  it('the ext paths answer DESCRIBE 404 Stream Not Found (CX820 as measured, and every model); main and sub play', async () => {
    const cx = await start({ CAMSIM_MODEL: 'CX820' });
    expect(await probe(cx.url('h264Preview_01_sub'))).toMatchObject({ codec: 'h264', width: 640 });
    for (const path of ['h264Preview_01_ext', 'Preview_01_ext', 'h265Preview_01_ext']) {
      expect((await probe(cx.url(path))).error).toMatch(/404 Not Found|Stream Not Found/);
      expect(await describe404(cx.port, path)).toMatch(/^RTSP\/1\.0 404 Stream Not Found\r\nCSeq: 2\r\n/);
    }
    expect(cx.svc.publishing()).toBe(2);
    const rlc = await start();
    expect(await describe404(rlc.port, 'h264Preview_01_ext')).toMatch(/^RTSP\/1\.0 404 Stream Not Found/);
  }, 90_000);

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
      await expect(svc.start()).rejects.toThrow(/RTSP port is not available/);
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

  it.skipIf(!mediamtx)('serves the pipeline on h264Preview_01_sub while it runs, and the copy again after', async () => {
    const e = await makeEngine();
    const rtsp = new RtspService(e, { port: await freePort(), mediamtx });
    services.push(rtsp);
    await rtsp.start();
    const p = new SdPipeline(e, { fonts: findFonts(), rtspUrl: () => rtsp.publisherUrl('sub'), onProcess: (up: boolean) => rtsp.setSubSource(up ? 'pipeline' : 'copy') });
    const url = `rtsp://cams:cams-pw@127.0.0.1:${rtsp.port()}/h264Preview_01_sub`;
    try {
      e.pipelineOn(5);
      for (let i = 0; i < 150 && !p.active(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(p.active()).toBe(true); // its FLV side works too (tee)
      expect(rtsp.publishing()).toBe(1); // only main's copy: the pipeline publishes sub
      expect(await probe(url)).toMatchObject({ codec: 'h264', width: 896 });
      e.pipelineOff();
      await new Promise((r) => setTimeout(r, 2500));
      expect(rtsp.publishing()).toBe(2); // sub's copy is back
      expect(await probe(url)).toMatchObject({ codec: 'h264', width: 896 });
    } finally {
      await p.stop();
    }
  }, 60_000);

  // Final review I1: without MediaMTX, a pipeline on/off must not start a
  // publisher that respawns every second.
  it('starts no sub publisher on a pipeline hand-back when MediaMTX is missing', async () => {
    const engine = await makeEngine();
    const svc = new RtspService(engine, { port: await freePort(), host: '127.0.0.1', mediamtx: undefined });
    await svc.start();
    svc.setSubSource('pipeline');
    svc.setSubSource('copy');
    let most = 0;
    for (let i = 0; i < 25; i++) {
      most = Math.max(most, svc.publishing());
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(most).toBe(0);
    await svc.stop();
  });

  // Final review I2: rtsp.reset cuts sub readers while the pipeline publishes sub.
  it.skipIf(!mediamtx)('cuts sub readers under rtsp.reset while the pipeline publishes', async () => {
    const e = await makeEngine();
    const rtsp = new RtspService(e, { port: 0, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(rtsp);
    await rtsp.start();
    const p = new SdPipeline(e, { fonts: findFonts(), rtspUrl: () => rtsp.publisherUrl('sub'), onProcess: (up: boolean) => rtsp.setSubSource(up ? 'pipeline' : 'copy') });
    rtsp.onDropReaders(() => p.restartNow());
    try {
      e.pipelineOn(5);
      for (let i = 0; i < 150 && !p.active(); i++) await new Promise((r) => setTimeout(r, 100));
      const reader = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://cams:cams-pw@127.0.0.1:${rtsp.port()}/h264Preview_01_sub`, '-f', 'null', '-']);
      const exited = new Promise((r) => reader.once('exit', r));
      await new Promise((r) => setTimeout(r, 1500));
      e.faults.set({ name: 'rtsp.reset' });
      await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('reader not cut (pipeline)')), 15_000))]);
    } finally {
      e.faults.clearAll();
      await p.stop();
    }
  }, 60_000);
});

// A sequence plays as one RTSP stream: one publisher reads the concat of the
// clips, looped, starting at the sequence clock (spec 2026-11-06, Playing).
describe.skipIf(!mediamtx)('RTSP: a sequence', () => {
  // Two compatible 2 s videos: a dark one and a bright one, told apart by luma.
  async function startSeq() {
    const engine = await makeEngine();
    engine.config.mainSize = '640x360';
    const src = mkdtempSync(join(tmpdir(), 'camsim-rtsp-seq-src-'));
    for (const [n, c] of [['a', 'black'], ['b', 'white']]) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${c}:size=320x240:rate=15`, '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(src, `${n}.mp4`)]);
    }
    const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-rtsp-seq-cache-')) });
    await lib.prepareAll();
    const port = await freePort();
    const svc = new RtspService(engine, { port, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    expect(lib.selectSequence(['a', 'b'])).toBeNull();
    return { engine, svc, url: (path: string) => `rtsp://cams:cams-pw@127.0.0.1:${port}/${path}` };
  }

  // This process's ffmpeg children whose command line passes `match`.
  async function ffmpegs(match: (args: string) => boolean): Promise<Array<{ pid: number; args: string }>> {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,args=']);
    return stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
      .filter((m) => Number(m[2]) === process.pid && m[3].includes('ffmpeg') && match(m[3]))
      .map((m) => ({ pid: Number(m[1]), args: m[3] }));
  }
  const publishers = (path: string) => ffmpegs((args) => args.endsWith(`/${path}`));

  it('plays a sequence without a reconnect', async () => {
    const { url } = await startSeq();
    const out = join(mkdtempSync(join(tmpdir(), 'camsim-rtsp-seq-out-')), 'main.mkv');
    // The selection restarts the publishers; read once the sequence is on.
    await expect.poll(async () => (await publishers('h264Preview_01_main')).some((p) => p.args.includes(' concat ')), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await probe(url('h264Preview_01_main'))).width, { timeout: 20_000, interval: 500 }).toBe(640);
    // ffmpeg exits 0 after 6 s of the stream: no cut on the way.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url('h264Preview_01_main'), '-t', '6', '-map', '0:v', '-c', 'copy', '-y', out], { timeout: 30_000 });
    const { stdout: pkts } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', out]);
    const pts = pkts.trim().split('\n').map(Number);
    expect(pts.length).toBeGreaterThan(60);
    // An RTSP reader gives the first packets of a session one time until the
    // sender's clock is known (the single-video paths too); from then on the
    // times rise without a step back, across every switch.
    const from = pts.findIndex((t) => t > pts[0]);
    expect(from).toBeLessThanOrEqual(3);
    for (let i = from + 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThan(pts[i - 1]);
    // Dark and bright frames alternate every 2 s: at least two switches.
    const { stdout: lumas } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', out, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
    const bright = [...lumas.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]) > 128);
    expect(bright.length).toBeGreaterThan(60);
    const switches = bright.filter((b, i) => i > 0 && b !== bright[i - 1]).length;
    expect(switches).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('a restarted publisher starts at the clock', async () => {
    const { engine } = await startSeq();
    const seq = engine.media as SequenceMedia;
    const calls: Array<{ at: number; args: string[] }> = [];
    const inputArgs = seq.inputArgs.bind(seq);
    seq.inputArgs = (stream) => {
      const args = inputArgs(stream);
      if (stream === 'main') calls.push({ at: Date.now(), args });
      return args;
    };
    let first: { pid: number; args: string } | undefined;
    await expect.poll(async () => (first = (await publishers('h264Preview_01_main')).find((p) => p.args.includes(' concat '))), { timeout: 10_000 }).toBeTruthy();
    // Long enough that the clock is well past the start.
    await new Promise((r) => setTimeout(r, 1500));
    const before = calls.length;
    process.kill(first!.pid, 'SIGTERM');
    let again: { pid: number; args: string } | undefined;
    await expect.poll(async () => (again = (await publishers('h264Preview_01_main')).find((p) => p.pid !== first!.pid && p.args.includes(' concat '))), { timeout: 10_000 }).toBeTruthy();
    expect(calls.length).toBe(before + 1);
    const { at, args } = calls.at(-1)!;
    const ss = Number(args[args.indexOf('-ss') + 1]);
    const { index, offsetMs } = seq.position(at);
    let expected = offsetMs;
    for (const id of seq.ids().slice(0, index)) expected += engine.mediaFor({ video: id }).durationMs('main');
    expect(expected).toBeGreaterThan(1000); // the restart did not start the sequence over
    expect(Math.abs(ss * 1000 - expected)).toBeLessThanOrEqual(100);
    expect(again!.args).toContain(` -ss ${args[args.indexOf('-ss') + 1]} `);
  }, 120_000);

  it('the SD pipeline reads the sequence too', async () => {
    const { engine, svc } = await startSeq();
    const p = new SdPipeline(engine, { fonts: findFonts(), rtspUrl: () => svc.publisherUrl('sub'), onProcess: (up: boolean) => svc.setSubSource(up ? 'pipeline' : 'copy') });
    try {
      engine.pipelineOn(5);
      await expect.poll(() => p.active(), { timeout: 20_000 }).toBe(true);
      const [pipe] = await ffmpegs((args) => args.includes(' -vf ') && args.includes('pipe:1'));
      expect(pipe.args).toMatch(/ -f concat -safe 0 -i \S+\/\.sequence\/sub-[0-9a-f]+\.txt -ss \d+\.\d{3} /);
    } finally {
      engine.pipelineOff();
      await p.stop();
    }
  }, 120_000);
});
