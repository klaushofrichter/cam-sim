import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import net, { type AddressInfo } from 'net';
import type { Engine } from '../engine/engine';
import { safeEqual as same } from '../util/safe-equal';

// The camera's RTSP paths (the main path says h264 on this camera too).
export const RTSP_PATHS = { main: 'h264Preview_01_main', sub: 'h264Preview_01_sub' } as const;
type Stream = keyof typeof RTSP_PATHS;

// CAMSIM_MEDIAMTX, then `mediamtx` on PATH, then tools/mediamtx (development).
export function findMediaMtx(): string | undefined {
  if (process.env.CAMSIM_MEDIAMTX) return existsSync(process.env.CAMSIM_MEDIAMTX) ? process.env.CAMSIM_MEDIAMTX : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, 'mediamtx'))) return join(dir, 'mediamtx');
  for (const dev of [join(__dirname, '..', '..', 'tools', 'mediamtx'), join(__dirname, '..', '..', '..', 'tools', 'mediamtx')]) if (existsSync(dev)) return dev;
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

class Stopped extends Error {}

// RTSP like the camera: MediaMTX serves the two paths, ffmpeg publishes the
// stream copies into them, and MediaMTX asks us (HTTP auth) whether a reader
// may watch: a camera user, RTSP switched on, the camera on and online, and
// no rtsp.refuse/rtsp.reset fault. rtsp.refuse only turns new readers away;
// the others also cut connected ones. TCP only, so MediaMTX needs no UDP ports.
export class RtspService {
  private mtx?: ChildProcess;
  private mtxExited = false;
  private auth?: http.Server;
  private readonly publishers = new Map<Stream, ChildProcess>();
  private readonly announced = new Set<string>();
  private dir?: string;
  private stopping = false;
  private up = false;
  private boundPort = 0;
  private starting?: Promise<void>;
  private readonly pubPassword = randomBytes(16).toString('hex');

  // Changes that must cut connected readers, like a camera that goes down.
  private readonly onState = (s: { power?: string; rebooting?: boolean }) => {
    if (s.power === 'off' || s.rebooting === true) this.dropReaders();
  };
  // A newly selected video: publishers restart on it (readers reconnect).
  private readonly onVideo = (v: { selected?: boolean }) => {
    if (v.selected) this.dropReaders();
  };
  private readonly onChange = () => {
    const e = this.engine;
    if (e.offline() || e.settings.running.NetPort.rtspEnable !== 1 || e.faults.active('rtsp.reset')) this.dropReaders();
  };

  constructor(private readonly engine: Engine, private readonly opts: { port: number; host?: string; mediamtx: string | undefined }) {}

  running(): boolean {
    return this.up;
  }

  port(): number {
    return this.boundPort;
  }

  pid(): number | undefined {
    return this.mtx?.pid;
  }

  publishing(): number {
    return this.publishers.size;
  }

  start(): Promise<void> {
    this.starting ??= this.doStart().catch(async (err) => {
      await this.teardown();
      if (err instanceof Stopped) return;
      throw err;
    });
    return this.starting;
  }

  private check(): void {
    if (this.stopping) throw new Stopped();
  }

  private async doStart(): Promise<void> {
    const e = this.engine;
    if (!this.opts.mediamtx) {
      e.log.warn('rtsp_unavailable_no_mediamtx');
      return;
    }
    const host = this.opts.host ?? '127.0.0.1';
    this.boundPort = this.opts.port || (await freePort(host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host));
    this.check();

    this.auth = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          res.statusCode = this.allow(JSON.parse(body)) ? 200 : 401;
        } catch {
          res.statusCode = 400;
        }
        res.end();
      });
    });
    await new Promise<void>((r, j) => this.auth!.once('error', j).listen(0, '127.0.0.1', () => r()));
    this.check();
    const authPort = (this.auth.address() as AddressInfo).port;

    this.dir = mkdtempSync(join(tmpdir(), 'camsim-rtsp-'));
    const conf = join(this.dir, 'mediamtx.yml');
    const listen = this.opts.host && !this.opts.host.includes(':') ? `${this.opts.host}:${this.boundPort}` : `:${this.boundPort}`;
    writeFileSync(conf, [
      'logLevel: warn',
      'logDestinations: [stdout]',
      'readTimeout: 10s',
      'writeTimeout: 10s',
      'authMethod: http',
      `authHTTPAddress: http://127.0.0.1:${authPort}/auth`,
      'api: false', 'metrics: false', 'pprof: false', 'playback: false',
      'rtsp: true',
      'rtspTransports: [tcp]',
      `rtspAddress: ${listen}`,
      'rtspAuthMethods: [basic]',
      // Everything but RTSP off, including MoQ (on by default since 1.2x, with
      // fixed ports and a certificate written to the working directory).
      'rtmp: false', 'hls: false', 'webrtc: false', 'srt: false', 'moq: false',
      'paths:',
      `  ${RTSP_PATHS.main}:`,
      `  ${RTSP_PATHS.sub}:`,
      '',
    ].join('\n'));

    const exited = new Promise<void>((resolve) => {
      const m = spawn(this.opts.mediamtx!, [conf], { stdio: ['ignore', 'pipe', 'pipe'], cwd: this.dir });
      this.mtx = m;
      m.stdout?.on('data', (d) => e.log.debug({ mediamtx: String(d).trim() }, 'mediamtx'));
      m.stderr?.on('data', (d) => e.log.warn({ mediamtx: String(d).trim() }, 'mediamtx'));
      m.on('error', (err) => {
        e.log.error({ err: err.message }, 'mediamtx_spawn_failed');
        this.mtxExited = true;
        resolve();
      });
      m.on('exit', (code, signal) => {
        this.mtxExited = true;
        if (!this.stopping) {
          e.log.error({ code, signal }, 'mediamtx_exited');
          this.up = false;
          this.stopPublishers();
        }
        resolve();
      });
    });

    // Ready when MediaMTX accepts connections, or failed when it exits first.
    const ready = (async () => {
      for (let i = 0; i < 100 && !this.mtxExited; i++) {
        if (await this.accepts(host)) return true;
        await sleep(100);
      }
      return false;
    })();
    const ok = await Promise.race([ready, exited.then(() => false)]);
    this.check();
    if (!ok || this.mtxExited) throw new Error('MediaMTX did not start (port in use or binary not runnable?)');

    for (const stream of ['main', 'sub'] as const) this.publish(stream);
    // Readiness: both publishers announced their stream (seen by the auth
    // callback), then a moment for MediaMTX to set the path up.
    for (let i = 0; i < 150 && this.announced.size < 2; i++) {
      await sleep(100);
      this.check();
      if (this.mtxExited) throw new Error('MediaMTX exited during start');
    }
    await sleep(300);
    this.check();
    e.bus.on('state', this.onState);
    e.bus.on('fault', this.onChange);
    e.bus.on('settings', this.onChange);
    e.bus.on('video', this.onVideo);
    this.up = true;
    e.log.info({ port: this.boundPort, ready: this.announced.size === 2 }, 'rtsp_listening');
  }

  private accepts(host: string): Promise<boolean> {
    return new Promise((r) => {
      const s = new net.Socket();
      s.setTimeout(500);
      s.once('connect', () => (s.destroy(), r(true)));
      s.once('error', () => r(false));
      s.once('timeout', () => (s.destroy(), r(false)));
      s.connect(this.boundPort, host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
    });
  }

  private allow(a: { user?: string; password?: string; action?: string; path?: string; ip?: string }): boolean {
    const e = this.engine;
    if (a.action === 'publish') {
      const ok = a.user === 'camsim-publisher' && same(a.password ?? '', this.pubPassword) && (a.ip === '127.0.0.1' || a.ip === '::1');
      if (ok && a.path) this.announced.add(a.path);
      return ok;
    }
    if (a.action !== 'read') return false;
    if (!Object.values(RTSP_PATHS).includes(a.path as never)) return false;
    if (e.offline() || e.settings.running.NetPort.rtspEnable !== 1 || e.faults.active('rtsp.refuse') || e.faults.active('rtsp.reset')) return false;
    const u = e.config.users.find((x) => x.name === a.user);
    return !!u && same(a.password ?? '', u.password);
  }

  private publish(stream: Stream): void {
    const e = this.engine;
    if (this.stopping || this.mtxExited) return;
    const url = `rtsp://camsim-publisher:${this.pubPassword}@127.0.0.1:${this.boundPort}/${RTSP_PATHS[stream]}`;
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', e.media.clipPath(stream),
      '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', url], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr?.on('data', (d) => e.log.debug({ ffmpeg: String(d).trim().replaceAll(this.pubPassword, '***') }, 'rtsp_publisher'));
    p.on('error', (err) => e.log.error({ err: err.message }, 'rtsp_publisher_spawn_failed'));
    p.on('exit', () => {
      if (this.publishers.get(stream) === p) this.publishers.delete(stream);
      // Restarted while MediaMTX runs; readers cut by dropReaders reconnect.
      if (!this.stopping && !this.mtxExited) setTimeout(() => this.publish(stream), 1000).unref();
    });
    this.publishers.set(stream, p);
  }

  // Readers drop when their publisher goes away; it restarts a second later.
  dropReaders(): void {
    for (const p of this.publishers.values()) p.kill('SIGTERM');
  }

  private stopPublishers(): void {
    for (const p of this.publishers.values()) p.kill('SIGTERM');
    this.publishers.clear();
  }

  private async teardown(): Promise<void> {
    this.up = false;
    this.engine.bus.off('state', this.onState);
    this.engine.bus.off('fault', this.onChange);
    this.engine.bus.off('settings', this.onChange);
    this.engine.bus.off('video', this.onVideo);
    this.stopPublishers();
    const m = this.mtx;
    if (m && !this.mtxExited && m.exitCode === null && m.signalCode === null) {
      await new Promise<void>((r) => {
        m.once('exit', () => r());
        m.kill('SIGTERM');
        setTimeout(() => (m.kill('SIGKILL'), r()), 3000).unref();
      });
    }
    const a = this.auth;
    this.auth = undefined;
    if (a) await new Promise<void>((r) => a.close(() => r()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.starting?.catch(() => undefined);
    await this.teardown();
  }
}
