import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import net from 'net';
import { FtpSrv } from 'ftp-srv';
import { generate } from 'selfsigned';
import { makeEngine, makeCamera, post, login } from './helpers';
import { FtpUploader } from '../src/ftp/uploader';
import { loadConfig } from '../src/config';
import { createCamSim } from '../src/index';
import { createControlApp } from '../src/control-api/app';
import { listen } from './helpers';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (closers.length) await closers.pop()!();
});

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

// An FTP(S) server writing into a temp dir; user "cam" / password "pw".
async function ftpServer(opts: { tls?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'camsim-ftp-'));
  const port = await freePort();
  let tls: { key: string; cert: string } | false = false;
  if (opts.tls) {
    const p = await generate([{ name: 'commonName', value: 'gateway.test' }], { keySize: 2048 });
    tls = { key: p.private, cert: p.cert };
  }
  const srv = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: 30000, pasv_max: 30100, anonymous: false, tls, log: { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } } as never });
  const logins: string[] = [];
  srv.on('login', ({ username, password }: { username: string; password: string }, resolve: (o: { root: string }) => void, reject: (e: Error) => void) => {
    logins.push(username);
    if (username === 'cam' && password === 'pw') resolve({ root });
    else reject(new Error('bad login'));
  });
  await srv.listen();
  closers.push(() => srv.close());
  return { port, root, logins };
}

const ftpObject = (engine: Awaited<ReturnType<typeof makeEngine>>, over: Record<string, unknown>): Record<string, any> => ({
  ...engine.settings.get('Ftp'), server: '127.0.0.1', userName: 'cam', password: 'pw', remoteDir: 'cams/den', enable: 1, onlyFtps: 0, ...over,
});

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${rel}${n}/`);
      else out.push(`${rel}${n}`);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out.sort();
}

describe('FTP upload', () => {
  it('uploads the main clip and a JPEG after each recording, named like the camera', async () => {
    const s = await ftpServer();
    const engine = await makeEngine({ CAMSIM_NAME: 'Den' });
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, { port: s.port }) }, { strictPartial: true });
    vi.useFakeTimers({ now: new Date('2026-09-26T11:52:21Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    engine.events.trigger('motion', 2);
    vi.advanceTimersByTime(20_000);
    vi.useRealTimers();
    await expect.poll(() => files(s.root), { timeout: 10_000 }).toEqual([
      'cams/den/2026/09/26/Den_00_20260926065221.jpg',
      'cams/den/2026/09/26/Den_00_20260926065221.mp4',
    ]);
    const mp4 = readFileSync(join(s.root, 'cams/den/2026/09/26/Den_00_20260926065221.mp4'));
    expect(mp4.length).toBe(engine.media.clipSize('main'));
    // The server shows the files a moment before the client's upload returns.
    await expect.poll(() => engine.counters.ftpUploads).toBe(1);
  });

  it('uploads the sub clip with streamType 1, and over FTPS with onlyFtps 1', async () => {
    const s = await ftpServer({ tls: true });
    const engine = await makeEngine({ CAMSIM_NAME: 'Den' });
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, { port: s.port, onlyFtps: 1, streamType: 1, remoteDir: '' }) }, { strictPartial: true });
    const { recording } = engine.events.trigger('motion', 1);
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    const list = files(s.root);
    expect(list).toHaveLength(2);
    const mp4 = list.find((f) => f.endsWith('.mp4'))!;
    expect(readFileSync(join(s.root, mp4)).length).toBe(engine.media.clipSize('sub'));
  });

  it('does nothing when FTP is off or the schedule excludes the triggers', async () => {
    const s = await ftpServer();
    const engine = await makeEngine();
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    const { recording } = engine.events.trigger('person', 1);
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    expect(files(s.root)).toEqual([]);
    const f = ftpObject(engine, { port: s.port });
    for (const k of Object.keys(f.schedule.table)) f.schedule.table[k] = '0'.repeat(168);
    engine.settings.set('SetFtpV20', { Ftp: f }, { strictPartial: true });
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    expect(files(s.root)).toEqual([]);
  });

  it('counts failures and honours the ftp.fail fault', async () => {
    const s = await ftpServer();
    const engine = await makeEngine();
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, { port: s.port, password: 'wrong' }) }, { strictPartial: true });
    const { recording } = engine.events.trigger('motion', 1);
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    expect(engine.counters.ftpFailures).toBe(1);
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, { port: s.port }) }, { strictPartial: true });
    engine.faults.set({ name: 'ftp.fail' });
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    expect(engine.counters.ftpFailures).toBe(2);
    expect(files(s.root)).toEqual([]);
  });
});

describe('TestFtp', () => {
  it("connects and logs in with the whole object, answering like the firmware", async () => {
    const s = await ftpServer();
    const { app, engine } = await makeCamera();
    const t = await login(app);
    const ok = await post(app, 'TestFtp', { Ftp: ftpObject(engine, { port: s.port }) }, t);
    expect(ok.reply).toEqual({ cmd: 'TestFtp', code: 0, value: { rspCode: 200 } });
    expect(s.logins).toEqual(['cam']);
    const bad = await post(app, 'TestFtp', { Ftp: ftpObject(engine, { port: s.port, password: 'nope' }) }, t);
    expect(bad.reply).toEqual({ cmd: 'TestFtp', code: 1, error: { detail: 'ftp connect failed', rspCode: -454 } });
    const partial = await post(app, 'TestFtp', { Ftp: { server: '127.0.0.1' } }, t);
    expect(partial.reply).toEqual({ cmd: 'TestFtp', code: 1, error: { detail: 'err get data from json', rspCode: -56 } });
    expect(engine.settings.running.Ftp.server).toBe(''); // never saved
  });
});

describe('CAMSIM_FTP_* at start', () => {
  it('configures and enables FTP', () => {
    const c = loadConfig({ CAMSIM_USERS: 'a:admin:b', CAMSIM_FTP_SERVER: 'gw', CAMSIM_FTP_PORT: '2121', CAMSIM_FTP_USER: 'cam', CAMSIM_FTP_PASSWORD: 'pw', CAMSIM_FTP_DIR: 'clips', CAMSIM_FTP_TLS: 'false', CAMSIM_FTP_STREAM: 'sub' });
    expect(c.ftp).toEqual({ server: 'gw', port: 2121, userName: 'cam', password: 'pw', remoteDir: 'clips', onlyFtps: 0, streamType: 1 });
    expect(loadConfig({ CAMSIM_USERS: 'a:admin:b' }).ftp).toBeUndefined();
    expect(() => loadConfig({ CAMSIM_USERS: 'a:admin:b', CAMSIM_FTP_SERVER: 'gw', CAMSIM_FTP_STREAM: 'hd' })).toThrow(/CAMSIM_FTP_STREAM/);
  });
});

describe('FTP end to end', () => {
  it('a simulator started with CAMSIM_FTP_* uploads a triggered recording by itself', async () => {
    const s = await ftpServer();
    const config = loadConfig({ CAMSIM_USERS: 'u:admin:p', CAMSIM_NAME: 'Gate', CAMSIM_FTP_SERVER: '127.0.0.1', CAMSIM_FTP_PORT: String(s.port), CAMSIM_FTP_USER: 'cam', CAMSIM_FTP_PASSWORD: 'pw', CAMSIM_FTP_DIR: 'in', CAMSIM_FTP_TLS: 'false', CAMSIM_LOG_LEVEL: 'silent' });
    const sim = await createCamSim({ users: config.users }, config);
    closers.push(() => sim.close());
    sim.engine.settings.running.Rec.postRec = '1 Seconds';
    sim.engine.events.trigger('vehicle', 1);
    await expect.poll(() => files(s.root).filter((f) => f.startsWith('in/')).length, { timeout: 15_000 }).toBe(2);
    expect(files(s.root)[0]).toMatch(/^in\/\d{4}\/\d{2}\/\d{2}\/Gate_00_\d{14}\.jpg$/);
  }, 20_000);
});

describe('FTP fixes from review', () => {
  it('reports each upload on the SSE feed', async () => {
    const s = await ftpServer();
    const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: 'tok' });
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, { port: s.port }) }, { strictPartial: true });
    const srv = await listen(createControlApp(engine));
    closers.push(srv.close);
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/sim/api/stream`, { headers: { Authorization: 'Bearer tok' }, signal: ac.signal });
    const reader = res.body!.getReader();
    const { recording } = engine.events.trigger('motion', 1);
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    let text = '';
    while (!/event: ftp\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    expect(text).toMatch(/event: ftp\ndata: \{"file":"cams\/den\/\d{4}\/\d{2}\/\d{2}\/Cam_00_\d{14}\.mp4","ok":true/);
  });

  it('a counted ftp.fail fails only the next N uploads', async () => {
    const s = await ftpServer();
    const engine = await makeEngine();
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, { port: s.port }) }, { strictPartial: true });
    engine.faults.set({ name: 'ftp.fail', count: 1 });
    const { recording } = engine.events.trigger('motion', 1);
    const rec = engine.sd.byId(recording!.id)!;
    await up.uploadRecording(rec);
    await up.uploadRecording(rec);
    expect([engine.counters.ftpFailures, engine.counters.ftpUploads]).toEqual([1, 1]);
  });

  it('keeps at most 20 uploads waiting, and stop() drops the rest', async () => {
    const engine = await makeEngine();
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, { port: 1 }) }, { strictPartial: true });
    engine.faults.set({ name: 'ftp.delayMs', ms: 200 });
    const { recording } = engine.events.trigger('motion', 1);
    const rec = engine.sd.byId(recording!.id)!;
    for (let i = 0; i < 30; i++) engine.events.emit('recording', rec);
    expect(up.pending()).toBe(20);
    expect(engine.counters.ftpDropped).toBe(10);
    up.stop();
    expect(up.pending()).toBe(0);
  });

  it('refuses a camera name that cannot be a file name', () => {
    expect(() => loadConfig({ CAMSIM_USERS: 'a:admin:b', CAMSIM_NAME: 'Front/Door' })).toThrow(/CAMSIM_NAME/);
    expect(loadConfig({ CAMSIM_USERS: 'a:admin:b', CAMSIM_NAME: 'Front Door 2' }).name).toBe('Front Door 2');
  });
});
