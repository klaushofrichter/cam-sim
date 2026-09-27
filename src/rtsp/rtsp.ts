import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { randomBytes } from 'crypto';
import { safeEqual as same } from '../util/safe-equal';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import net, { type AddressInfo } from 'net';
import type { Engine } from '../engine/engine';

// The camera's RTSP paths (the main path says h264 on this camera too).
export const RTSP_PATHS = { main: 'h264Preview_01_main', sub: 'h264Preview_01_sub' } as const;

// CAMSIM_MEDIAMTX, then `mediamtx` on PATH, then tools/mediamtx (development).
export function findMediaMtx(): string | undefined {
  if (process.env.CAMSIM_MEDIAMTX) return existsSync(process.env.CAMSIM_MEDIAMTX) ? process.env.CAMSIM_MEDIAMTX : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, 'mediamtx'))) return join(dir, 'mediamtx');
  const dev = join(__dirname, '..', '..', 'tools', 'mediamtx');
  if (existsSync(dev)) return dev;
  const devDist = join(__dirname, '..', '..', '..', 'tools', 'mediamtx');
  return existsSync(devDist) ? devDist : undefined;
}

// RTSP like the camera: MediaMTX serves the two paths, ffmpeg publishes the
// stream copies into them, and MediaMTX asks us (HTTP auth) whether a reader
// may watch: a camera user, RTSP switched on, the camera on and online, and
// no rtsp.refuse fault. TCP only, so MediaMTX needs no UDP ports.
export class RtspService {
  private mtx?: ChildProcess;
  private auth?: http.Server;
  private readonly publishers = new Map<string, ChildProcess>();
  private dir?: string;
  private stopping = false;
  private readonly pubPassword = randomBytes(16).toString('hex');
  private readonly onState = (s: { power?: string; rebooting?: boolean }) => {
    // Power-off and reboot cut readers, like the camera going down.
    if (s.power === 'off' || s.rebooting === true) this.dropReaders();
  };

  constructor(private readonly engine: Engine, private readonly opts: { port: number; host?: string; mediamtx: string | undefined }) {}

  running(): boolean {
    return !!this.mtx && !this.stopping;
  }

  async start(): Promise<void> {
    const e = this.engine;
    if (!this.opts.mediamtx) {
      e.log.warn('rtsp_unavailable_no_mediamtx');
      return;
    }
    this.auth = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const a = JSON.parse(body) as { user?: string; password?: string; action?: string; path?: string; ip?: string };
          res.statusCode = this.allow(a) ? 200 : 401;
        } catch {
          res.statusCode = 400;
        }
        res.end();
      });
    });
    await new Promise<void>((r) => this.auth!.listen(0, '127.0.0.1', () => r()));
    const authPort = (this.auth.address() as AddressInfo).port;

    this.dir = mkdtempSync(join(tmpdir(), 'camsim-rtsp-'));
    const conf = join(this.dir, 'mediamtx.yml');
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
      `rtspAddress: ${this.opts.host ?? ''}:${this.opts.port}`,
      'rtspAuthMethods: [basic]',
      // Everything but RTSP off, including MoQ (on by default since 1.2x, with
      // fixed ports and a certificate written to the working directory).
      'rtmp: false', 'hls: false', 'webrtc: false', 'srt: false', 'moq: false',
      'paths:',
      `  ${RTSP_PATHS.main}:`,
      `  ${RTSP_PATHS.sub}:`,
      '',
    ].join('\n'));
    this.mtx = spawn(this.opts.mediamtx, [conf], { stdio: ['ignore', 'pipe', 'pipe'], cwd: this.dir });
    this.mtx.stdout?.on('data', (d) => e.log.debug({ mediamtx: String(d).trim() }, 'mediamtx'));
    this.mtx.stderr?.on('data', (d) => e.log.warn({ mediamtx: String(d).trim() }, 'mediamtx'));
    this.mtx.on('exit', (code) => {
      if (!this.stopping) e.log.error({ code }, 'mediamtx_exited');
    });
    await this.waitForPort();
    for (const stream of ['main', 'sub'] as const) this.publish(stream);
    await this.waitForPublishers();
    e.bus.on('state', this.onState);
    e.log.info({ port: this.opts.port }, 'rtsp_listening');
  }

  private allow(a: { user?: string; password?: string; action?: string; path?: string; ip?: string }): boolean {
    const e = this.engine;
    if (a.action === 'publish') return a.user === 'camsim-publisher' && same(a.password ?? '', this.pubPassword) && (a.ip === '127.0.0.1' || a.ip === '::1');
    if (a.action !== 'read') return false;
    if (!Object.values(RTSP_PATHS).includes(a.path as never)) return false;
    if (e.offline() || e.settings.running.NetPort.rtspEnable !== 1 || e.faults.active('rtsp.refuse')) return false;
    const u = e.config.users.find((x) => x.name === a.user);
    return !!u && same(a.password ?? '', u.password);
  }

  private publish(stream: 'main' | 'sub'): void {
    const e = this.engine;
    const url = `rtsp://camsim-publisher:${this.pubPassword}@127.0.0.1:${this.opts.port}/${RTSP_PATHS[stream]}`;
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', e.media.clipPath(stream),
      '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', url], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr?.on('data', (d) => e.log.debug({ ffmpeg: String(d).trim().replace(this.pubPassword, '***') }, 'rtsp_publisher'));
    p.on('exit', () => {
      this.publishers.delete(stream);
      if (!this.stopping) setTimeout(() => !this.stopping && this.publish(stream), 1000).unref();
    });
    this.publishers.set(stream, p);
  }

  // Readers drop when their publisher goes away; it restarts a second later.
  dropReaders(): void {
    for (const p of this.publishers.values()) p.kill('SIGTERM');
  }

  private async waitForPort(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const ok = await new Promise<boolean>((r) => {
        const s = new net.Socket();
        s.once('connect', () => (s.destroy(), r(true)));
        s.once('error', () => r(false));
        s.connect(this.opts.port, this.opts.host ?? '127.0.0.1');
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('MediaMTX did not start');
  }

  private async waitForPublishers(): Promise<void> {
    // ffmpeg needs a moment to connect and announce; readers arriving earlier
    // would find no stream yet.
    await new Promise((r) => setTimeout(r, 1500));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.engine.bus.off('state', this.onState);
    for (const p of this.publishers.values()) p.kill('SIGTERM');
    this.publishers.clear();
    if (this.mtx) {
      const m = this.mtx;
      await new Promise<void>((r) => {
        m.once('exit', () => r());
        m.kill('SIGTERM');
        setTimeout(() => (m.kill('SIGKILL'), r()), 3000).unref();
      });
    }
    this.mtx = undefined;
    await new Promise<void>((r) => (this.auth ? this.auth.close(() => r()) : r()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
