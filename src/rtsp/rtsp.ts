import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import net, { type AddressInfo } from 'net';
import type { Engine } from '../engine/engine';
import { safeEqual as same } from '../util/safe-equal';
import { text } from 'stream/consumers';
import { sleep } from '../util/sleep';
import { listen as listenOn } from '../util/net';
import { encodingOf } from '../media/encoding';
import { inputArgsOf } from '../media/source';
import { RtspFront } from './front';

// The camera's RTSP paths (the main path says h264 on this camera too).
const RTSP_PATHS = { main: 'h264Preview_01_main', sub: 'h264Preview_01_sub' } as const;
type Stream = keyof typeof RTSP_PATHS;
// The third stream (ext, the app's Balanced) is not on RTSP: the real CX820
// answers DESCRIBE for these paths with 404 Stream Not Found (measured
// 2026-11-03; its ext is on FLV only). Every model answers so here.
export const NO_STREAM_PATHS: readonly string[] = ['h264Preview_01_ext', 'Preview_01_ext', 'h265Preview_01_ext'];

// CAMSIM_MEDIAMTX, then `mediamtx` on PATH, then tools/mediamtx (development).
export function findMediaMtx(): string | undefined {
  if (process.env.CAMSIM_MEDIAMTX) return existsSync(process.env.CAMSIM_MEDIAMTX) ? process.env.CAMSIM_MEDIAMTX : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, 'mediamtx'))) return join(dir, 'mediamtx');
  for (const dev of [join(__dirname, '..', '..', 'tools', 'mediamtx'), join(__dirname, '..', '..', '..', 'tools', 'mediamtx')]) if (existsSync(dev)) return dev;
  return undefined;
}

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

// MediaMTX starts on a newly picked port this often before start() fails.
const MTX_ATTEMPTS = 3;

// A process that exits without stop() (process.exit, an uncaught error, a test
// worker ended) must not leave MediaMTX and its publishers running (#70). One
// 'exit' listener for all services; a signal without a handler ends the
// process without it (the test setup sweeps those orphans).
const live = new Set<RtspService>();
let exitHooked = false;
function track(s: RtspService): void {
  live.add(s);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const x of live) x.killChildren();
  });
}

// RTSP like the camera: MediaMTX serves the two paths on the loopback behind
// the camera's port (RtspFront, which shapes the DESCRIBE's SDP like the
// model's), ffmpeg publishes the
// stream copies into them, and MediaMTX asks us (HTTP auth) whether a reader
// may watch: a camera user, RTSP switched on, the camera on and online, and
// no rtsp.refuse/rtsp.reset fault. rtsp.refuse only turns new readers away;
// the others also cut connected ones. TCP only, so MediaMTX needs no UDP ports.
export class RtspService {
  private mtx?: ChildProcess;
  private mtxExited = false;
  // One per MediaMTX start: a publisher of an earlier one never restarts.
  private generation = 0;
  private auth?: http.Server;
  private readonly publishers = new Map<Stream, ChildProcess>();
  private readonly announced = new Set<string>();
  private dir?: string;
  private stopping = false;
  private up = false;
  private boundPort = 0;
  // MediaMTX's own port (loopback), behind the camera's port.
  private mtxPort = 0;
  private front?: RtspFront;
  private starting?: Promise<void>;
  private readonly pubPassword = randomBytes(16).toString('hex');
  // Who publishes sub: the stream copy, or the SD pipeline while it runs.
  private subMode: 'copy' | 'pipeline' = 'copy';
  // Others that publish (the SD pipeline) and must drop their readers too.
  private readonly dropHooks: Array<() => void> = [];

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
    if (!e.serving('rtsp') || e.faults.active('rtsp.reset')) this.dropReaders();
    else this.followEnc();
  };
  // The encoding each running publisher was started with (encodingOf().key).
  private readonly published = new Map<Stream, string>();

  // A SetEnc that changed a stream restarts its publisher on the new
  // encoding: its readers drop and reconnect, and the new stream starts with
  // the new parameter sets. Whether the real camera drops its RTSP sessions
  // on SetEnc was not measured; a client must cope with either.
  private followEnc(): void {
    for (const [stream, p] of this.publishers) {
      if (this.published.get(stream) !== encodingOf(this.engine, stream).key) p.kill('SIGTERM');
    }
  }

  constructor(private readonly engine: Engine, private readonly opts: { port: number; host?: string; mediamtx: string | undefined; pickPort?: () => Promise<number> }) {}

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
    // The camera's port first: a taken port fails before MediaMTX starts.
    this.front = new RtspFront({ upstreamPort: () => this.mtxPort, shape: () => e.profile.rtsp, notFound: (path) => NO_STREAM_PATHS.includes(path) });
    try {
      this.boundPort = await this.front.listen(this.opts.port, this.opts.host);
    } catch (err) {
      throw new Error(`the RTSP port is not available (${(err as NodeJS.ErrnoException).code ?? 'error'}); MediaMTX not started`);
    }
    this.check();

    this.auth = http.createServer(async (req, res) => {
      try {
        res.statusCode = this.allow(JSON.parse(await text(req))) ? 200 : 401;
      } catch {
        res.statusCode = 400;
      }
      res.end();
    });
    const authPort = await listenOn(this.auth, 0, '127.0.0.1');
    this.check();
    this.dir = mkdtempSync(join(tmpdir(), 'camsim-rtsp-'));

    // MediaMTX's port is picked free and bound by MediaMTX a moment later, so
    // another listener can take it in between: MediaMTX then exits at once (or
    // a stranger answers on it). Such a start is tried again on a new port.
    for (let attempt = 1; ; attempt++) {
      const failure = await this.startMediaMtx(authPort);
      this.check();
      if (!failure) break;
      if (attempt >= MTX_ATTEMPTS) throw new Error(failure);
      e.log.warn({ attempt, port: this.mtxPort, reason: failure }, 'mediamtx_retry_new_port');
    }
    await sleep(300);
    this.check();
    if (this.mtxExited) throw new Error('MediaMTX exited during start');
    for (const [topic, h] of this.subscriptions()) e.bus.on(topic, h);
    this.up = true;
    e.log.info({ port: this.boundPort, ready: this.announced.size === 2 }, 'rtsp_listening');
  }

  // One MediaMTX start on a newly picked loopback port, up to both publishers
  // announced: undefined when it runs, else why not (it is gone by then).
  private async startMediaMtx(authPort: number): Promise<string | undefined> {
    const e = this.engine;
    this.generation++;
    this.mtxExited = false;
    this.announced.clear();
    this.mtxPort = await (this.opts.pickPort ?? (() => freePort('127.0.0.1')))();
    this.check();

    const conf = join(this.dir!, 'mediamtx.yml');
    const listen = `127.0.0.1:${this.mtxPort}`;
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

    const m = spawn(this.opts.mediamtx!, [conf], { stdio: ['ignore', 'pipe', 'pipe'], cwd: this.dir });
    this.mtx = m;
    track(this);
    const exited = new Promise<void>((resolve) => {
      m.stdout?.on('data', (d) => e.log.debug({ mediamtx: String(d).trim() }, 'mediamtx'));
      m.stderr?.on('data', (d) => e.log.warn({ mediamtx: String(d).trim() }, 'mediamtx'));
      m.on('error', (err) => {
        e.log.error({ err: err.message }, 'mediamtx_spawn_failed');
        if (this.mtx === m) this.mtxExited = true;
        resolve();
      });
      m.on('exit', (code, signal) => {
        if (this.mtx === m) {
          this.mtxExited = true;
          if (!this.stopping && this.up) {
            e.log.error({ code, signal }, 'mediamtx_exited');
            this.up = false;
            this.stopPublishers();
          }
        }
        resolve();
      });
    });
    // A failed attempt: no publishers and no MediaMTX left from it.
    const fail = async (why: string) => {
      this.generation++;
      this.stopPublishers();
      if (m.exitCode === null && m.signalCode === null) m.kill('SIGKILL');
      await exited;
      this.mtxExited = true;
      return why;
    };

    // Ready when MediaMTX accepts connections, or failed when it exits first.
    const ready = (async () => {
      for (let i = 0; i < 100 && !this.mtxExited; i++) {
        if (await this.accepts()) return true;
        await sleep(100);
      }
      return false;
    })();
    const ok = await Promise.race([ready, exited.then(() => false)]);
    this.check();
    if (!ok || this.mtxExited) return fail('MediaMTX did not start (port in use or binary not runnable?)');

    for (const stream of ['main', 'sub'] as const) this.publish(stream);
    // Readiness: both publishers announced their stream (seen by the auth
    // callback), then a moment for MediaMTX to set the path up.
    for (let i = 0; i < 150 && this.announced.size < 2; i++) {
      await sleep(100);
      this.check();
      if (this.mtxExited) return fail('MediaMTX exited during start');
    }
    return undefined;
  }

  private accepts(): Promise<boolean> {
    return new Promise((r) => {
      const s = new net.Socket();
      s.setTimeout(500);
      s.once('connect', () => (s.destroy(), r(true)));
      s.once('error', () => r(false));
      s.once('timeout', () => (s.destroy(), r(false)));
      s.connect(this.mtxPort, '127.0.0.1');
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
    if (!e.serving('rtsp') || e.faults.active('rtsp.refuse') || e.faults.active('rtsp.reset')) return false;
    const u = e.config.users.find((x) => x.name === a.user);
    return !!u && same(a.password ?? '', u.password);
  }

  // The SD pipeline publishes sub itself while it runs (spec 2026-09-29).
  publisherUrl(stream: Stream): string | undefined {
    if (!this.up || this.mtxExited) return undefined;
    return this.pubUrl(stream);
  }

  private pubUrl(stream: Stream): string {
    return `rtsp://camsim-publisher:${this.pubPassword}@127.0.0.1:${this.mtxPort}/${RTSP_PATHS[stream]}`;
  }

  setSubSource(mode: 'copy' | 'pipeline'): void {
    if (mode === this.subMode) return;
    this.subMode = mode;
    if (mode === 'pipeline') this.publishers.get('sub')?.kill('SIGTERM');
    else if (this.up && !this.publishers.has('sub')) this.publish('sub'); // never without MediaMTX
  }

  private publish(stream: Stream): void {
    const e = this.engine;
    if (this.stopping || this.mtxExited) return;
    if (stream === 'sub' && this.subMode === 'pipeline') return;
    const enc = encodingOf(e, stream);
    const generation = this.generation;
    this.published.set(stream, enc.key);
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', ...inputArgsOf(e.media, stream),
      ...enc.args, '-f', 'rtsp', '-rtsp_transport', 'tcp', this.pubUrl(stream)], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr?.on('data', (d) => e.log.debug({ ffmpeg: String(d).trim().replaceAll(this.pubPassword, '***') }, 'rtsp_publisher'));
    p.on('error', (err) => e.log.error({ err: err.message }, 'rtsp_publisher_spawn_failed'));
    p.on('exit', () => {
      if (this.publishers.get(stream) === p) this.publishers.delete(stream);
      // Restarted while MediaMTX runs; readers cut by dropReaders reconnect.
      if (!this.stopping && !this.mtxExited && generation === this.generation && !(stream === 'sub' && this.subMode === 'pipeline')) setTimeout(() => this.publish(stream), 1000).unref();
    });
    this.publishers.set(stream, p);
  }

  // Readers drop when their publisher goes away; it restarts a second later.
  dropReaders(): void {
    for (const p of this.publishers.values()) p.kill('SIGTERM');
    for (const fn of this.dropHooks) fn();
  }

  // The SD pipeline restarts when readers must be cut (rtsp.reset, offline,
  // power off), like the copy publishers.
  onDropReaders(fn: () => void): void {
    this.dropHooks.push(fn);
  }

  private stopPublishers(): void {
    for (const p of this.publishers.values()) p.kill('SIGTERM');
    this.publishers.clear();
  }

  // The bus topics it follows while up, in the order its handlers run.
  private subscriptions(): Array<[string, (...args: any[]) => void]> {
    return [['state', this.onState], ['fault', this.onChange], ['settings', this.onChange], ['video', this.onVideo]];
  }

  // At process exit: synchronous, SIGKILL (nothing runs after it to escalate).
  killChildren(): void {
    for (const p of this.publishers.values()) p.kill('SIGKILL');
    if (this.mtx && this.mtx.exitCode === null && this.mtx.signalCode === null) this.mtx.kill('SIGKILL');
  }

  private async teardown(): Promise<void> {
    live.delete(this);
    this.up = false;
    for (const [topic, h] of this.subscriptions()) this.engine.bus.off(topic, h);
    this.stopPublishers();
    const m = this.mtx;
    if (m && !this.mtxExited && m.exitCode === null && m.signalCode === null) {
      await new Promise<void>((r) => {
        m.once('exit', () => r());
        m.kill('SIGTERM');
        setTimeout(() => (m.kill('SIGKILL'), r()), 3000).unref();
      });
    }
    await this.front?.close();
    this.front = undefined;
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
