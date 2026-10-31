import type { LiveSubSource } from '../pipeline/live-sub';
import { EventEmitter } from 'events';
import { join } from 'path';
import type pino from 'pino';
import type { Response } from 'express';
import type { CamSimConfig } from '../config';
import { systemClock, type Clock } from './clock';
import { CameraTime } from './camera-time';
import { createRng, type Rng } from './rng';
import { Sessions } from './sessions';
import { SettingsStore } from './settings';
import { SdCard, DEMO_CLIPS } from './sdcard';
import { Events } from './events';
import { Faults } from './faults';
import { Counters } from './counters';
import type { MediaSource } from '../media/source';
import type { Library } from '../media/library';
import { ensureFixtures, defaultFixtureDir, FixtureMedia } from '../media/fixtures';
import { createLogger } from '../log';
import { Certificates } from '../tls/certs';
import { RequestLog } from './request-log';
import { profileFor, type CameraProfile } from '../profile/profile';
import { Ptz, ptzEnabled } from './ptz';
import { ptzText } from '../pipeline/overlay';
import { findFonts } from '../pipeline/fonts';
import { drawTextOnJpeg, renderJpeg } from '../pipeline/ptz-picture';
import { sleep } from '../util/sleep';

// Measured timings (CAMSIM_SPEED=real) and their fast stand-ins.
const TIMINGS = {
  real: { rebootMs: 60_000, searchMs: 300, loginMs: 200, downloadBytesPerS: 150 * 1024, certRestartMs: 10_000 },
  fast: { rebootMs: 1_000, searchMs: 20, loginMs: 0, downloadBytesPerS: 0, certRestartMs: 200 },
};

export interface RequestRecord {
  at: string;
  port: 'http' | 'https' | 'baichuan';
  method: string;
  path: string;
  cmd: string;
  status: number;
  ms: number;
  // Baichuan only: the request's and the direct reply's body lengths, never the bodies.
  len?: number;
  replyLen?: number;
}

// One simulated camera: every surface (camera API, control API, in-process
// tests) works on this object.
export class Engine {
  videoId = 'test-pattern';
  library?: Library; // set by the Library itself
  private readonly mediaById = new Map<string, MediaSource>();
  private readonly missingVideos = new Set<string>();
  readonly bus = new EventEmitter();
  readonly faults = new Faults();
  readonly counters = new Counters();
  readonly requests = new RequestLog();
  readonly sessions: Sessions;
  readonly settings: SettingsStore;
  // The camera's clock and zone (GetTime, SetTime).
  readonly time: CameraTime;
  readonly sd: SdCard;
  readonly events: Events;
  readonly rng: Rng;
  // The camera model's fixed answers (CAMSIM_MODEL).
  readonly profile: CameraProfile;
  // The virtual pan/tilt/zoom state of a PTZ model; null for fixed models.
  readonly ptz: Ptz | null;
  serial: string;
  rebooting = false;
  // Power: 'off' after power-off, 'booting' during power-on, else 'on'.
  power: 'on' | 'off' | 'booting' = 'on';
  // How the Reboot command behaves; unset: the speed's timing and a 50/50
  // chance of dropping the connection before answering (as the firmware does).
  rebootDefaults: { ms?: number; dropsConnection?: boolean } = {};
  limits = { flvBufferBytes: 4 * 1024 * 1024 };
  // The web server restarts after a certificate change (about 10 s on the camera).
  certRestarting = false;
  readonly certs: Certificates;
  // Device-wide: the firmware serializes these across all sessions.
  search = { busy: false, spoiled: false };
  readonly activeFlv = new Set<Response>();
  readonly activeDownloads = new Set<Response>();
  // The SD pipeline switch (cam-sim spec 2026-09-29): never persisted.
  pipeline: { on: boolean; until?: number; error?: string } = { on: false };
  private pipelineTimer?: NodeJS.Timeout;
  liveSub?: LiveSubSource; // set by SdPipeline
  // The ffmpeg that draws the PTZ position on snapshots (tests point it elsewhere).
  ffmpeg = 'ffmpeg';
  // The last PTZ snapshot (one entry: video and text), the font, and whether
  // a failure was logged.
  private ptzSnap?: { key: string; jpeg: Buffer };
  private ptzFont?: string | null;
  private ptzSnapFailed = false;
  // The last Snap picture at the main size (one entry: video and text), and
  // whether a failure was logged.
  private mainSnap?: { key: string; jpeg: Buffer };
  private mainSnapFailed = false;
  // The picture ffmpeg in flight (at most one per camera): requests of the
  // same kind share its result, others wait for it.
  private render?: { kind: string; run: Promise<Buffer> };
  // Set by the Baichuan server (src/baichuan/server.ts): device actions reach port 9000.
  baichuan?: { dropAll(): void; dropTransfers(): void };

  constructor(
    readonly config: CamSimConfig,
    readonly clock: Clock,
    readonly log: pino.Logger,
    public media: MediaSource,
  ) {
    this.profile = profileFor(config.model);
    if (ptzEnabled(this.profile.ability) && !this.profile.ptz) throw new Error(`profile ${this.profile.model} permits PTZ but has no ptz spec`);
    this.ptz = ptzEnabled(this.profile.ability) ? new Ptz(this.profile.ptz!, clock) : null;
    this.rng = createRng(config.seed);
    this.certs = new Certificates({ certFile: config.tlsCertFile, keyFile: config.tlsKeyFile, dataDir: config.dataDir });
    this.serial = this.newSerial();
    this.sessions = new Sessions(config.users, clock);
    this.time = new CameraTime(clock, config.tz);
    this.settings = new SettingsStore({ name: config.name, file: config.dataDir && join(config.dataDir, 'settings.json'), log, profile: this.profile });
    this.mediaById.set('test-pattern', media);
    this.sd = new SdCard({
      dir: config.dataDir && join(config.dataDir, 'sd'),
      capacityMb: config.sdMb,
      clock,
      tz: config.tz,
      log,
      fixtureSizes: () => ({ sub: this.media.clipSize('sub'), main: this.media.clipSize('main') }),
      currentVideo: () => this.videoId,
      fileFlags: this.profile.fileFlags,
    });
    this.events = new Events({ clock, tz: config.tz, sd: this.sd, settings: this.settings, rng: this.rng });
    for (const f of config.faults) this.faults.set(f);
    if (config.ftp) {
      const r = this.settings.set('SetFtpV20', { Ftp: { ...this.settings.get('Ftp'), ...config.ftp, enable: 1 } }, { strictPartial: true });
      if (r) this.log.warn({ rspCode: r.rspCode }, 'ftp_config_rejected');
    }
    if (config.seedClips === 'demo' && this.sd.all().length === 0) this.sd.seed(DEMO_CLIPS);
    this.faults.on('change', () => this.bus.emit('fault', this.faults.list()));
    this.events.on('event', (e) => this.bus.emit('event', e));
  }

  get timings() {
    return TIMINGS[this.config.speed];
  }

  private newSerial(): string {
    return `SIM${this.rng.hex(12)}`;
  }

  pipelineOn(minutes: number): void {
    clearTimeout(this.pipelineTimer);
    this.pipeline = { on: true, until: Date.now() + minutes * 60_000 };
    this.pipelineTimer = setTimeout(() => this.pipelineOff(), minutes * 60_000);
    this.pipelineTimer.unref?.();
    this.bus.emit('pipeline', this.pipelineState());
  }

  pipelineOff(error?: string): void {
    clearTimeout(this.pipelineTimer);
    this.pipelineTimer = undefined;
    this.pipeline = error ? { on: false, error } : { on: false };
    this.bus.emit('pipeline', this.pipelineState());
  }

  pipelineState(): { on: false; error?: string } | { on: true; until: number; running: boolean } {
    if (!this.pipeline.on) return this.pipeline.error ? { on: false, error: this.pipeline.error } : { on: false };
    return { on: true, until: this.pipeline.until!, running: !!this.liveSub?.active() };
  }

  // Switches what the camera shows (live, snapshots, RTSP, recordings).
  setMedia(media: MediaSource, id: string): void {
    if (this.media !== media) this.media.release?.();
    this.media = media;
    this.videoId = id;
    this.registerMedia(id, media);
    this.bus.emit('video', { id, selected: true });
  }

  // Library videos by id, so a recording is served from the video it was
  // made from (its sizes and names stay consistent after a switch).
  registerMedia(id: string, media: MediaSource): void {
    this.mediaById.set(id, media);
  }

  mediaFor(rec: { video?: string }): MediaSource {
    const id = rec.video ?? 'test-pattern';
    const m = this.mediaById.get(id);
    if (m) return m;
    // Its video is gone (no cached copy left): the current one stands in.
    if (!this.missingVideos.has(id)) {
      this.missingVideos.add(id);
      this.log.warn({ video: id }, 'recording_video_missing');
    }
    return this.media;
  }

  // The picture for the web UI (Snap: snapMain). PTZ models draw their position in
  // the middle (the simulator's; one ffmpeg run per new position, cached);
  // without a font, or when ffmpeg fails, the plain picture. Fixed models:
  // the media's snapshot unchanged. (The FTP upload keeps the plain picture:
  // whether the camera's FTP picture shows anything extra is not measured.)
  async snapshot(): Promise<Buffer> {
    const plain = await this.media.snapshot();
    if (!this.ptz) return plain;
    if (this.ptzFont === undefined) this.ptzFont = findFonts(this.config.fontDir)?.regular ?? null;
    if (!this.ptzFont) return plain;
    const font = this.ptzFont;
    const ptz = this.ptz;
    return this.rendered('ptz', async () => {
      const text = ptzText(ptz.position());
      const key = `${this.videoId}|${text}`;
      if (this.ptzSnap?.key === key) return this.ptzSnap.jpeg;
      try {
        const jpeg = await drawTextOnJpeg(plain, text, font, this.ffmpeg);
        this.ptzSnap = { key, jpeg };
        return jpeg;
      } catch (err) {
        if (!this.ptzSnapFailed) this.log.warn({ err: (err as Error).message }, 'ptz_snapshot_failed');
        this.ptzSnapFailed = true;
        return plain;
      }
    });
  }

  // Snap: the picture at the main stream's size as GetEnc reports it (the
  // camera's Snap is the main stream's; #126), with the PTZ position on PTZ
  // models. One ffmpeg run per video and position, cached; when ffmpeg
  // fails, the fixture picture as it is.
  async snapMain(): Promise<Buffer> {
    const plain = await this.media.snapshot();
    const { width, height } = this.profile.enc.mainStream;
    if (this.ptz && this.ptzFont === undefined) this.ptzFont = findFonts(this.config.fontDir)?.regular ?? null;
    const font = this.ptz && this.ptzFont ? this.ptzFont : undefined;
    const ptz = this.ptz;
    return this.rendered('snap', async () => {
      const text = font && ptz ? ptzText(ptz.position()) : undefined;
      const key = `${this.videoId}|${text ?? ''}`;
      if (this.mainSnap?.key === key) return this.mainSnap.jpeg;
      try {
        const jpeg = await renderJpeg(plain, { text, font, size: `${width}x${height}` }, this.ffmpeg);
        this.mainSnap = { key, jpeg };
        return jpeg;
      } catch (err) {
        if (!this.mainSnapFailed) this.log.warn({ err: (err as Error).message }, 'snap_scale_failed');
        this.mainSnapFailed = true;
        return plain;
      }
    });
  }

  // One picture ffmpeg at a time per camera (#114): stills polled during a
  // move would otherwise start one run each, as the text changes every time.
  // A request finding a run of its kind in flight shares that run's result
  // (the position it started with); a run of another kind is waited for.
  // `make` checks its cache first and never rejects.
  private async rendered(kind: string, make: () => Promise<Buffer>): Promise<Buffer> {
    while (this.render) {
      if (this.render.kind === kind) return this.render.run;
      await this.render.run;
    }
    const run = make().finally(() => {
      if (this.render?.run === run) this.render = undefined;
    });
    this.render = { kind, run };
    return run;
  }

  // Powered off, booting, rebooting or the offline fault: every port is down.
  down(): boolean {
    return this.power !== 'on' || this.rebooting || !!this.faults.active('offline');
  }

  // Down, or the web server restarting after a certificate change (HTTP,
  // HTTPS, RTSP, ONVIF; Baichuan's port 9000 stays up through that).
  offline(): boolean {
    return this.down() || this.certRestarting;
  }

  // A protocol's port answers: the camera is online and the port is enabled
  // (SetNetPort).
  serving(port: 'http' | 'https' | 'rtmp' | 'rtsp' | 'onvif'): boolean {
    return !this.offline() && this.settings.running.NetPort[`${port}Enable`] === 1;
  }

  // CertificateClear and a successful ImportCertificate restart the camera's
  // web server: sessions end, and clients must log in again.
  private async certRestart(): Promise<void> {
    this.bus.emit('cert', this.certs.state);
    this.sessions.revokeAll();
    this.certRestarting = true;
    await sleep(this.timings.certRestartMs);
    this.certRestarting = false;
  }

  clearCertificate(): void {
    this.certs.clear();
    void this.certRestart();
  }

  importCertificate(cert: string, key: string): number | null {
    const r = this.certs.import(cert, key);
    if (r === 'ignored') return null;
    if (r === null) void this.certRestart();
    return r;
  }

  // Reboot: offline for `ms`, then a new serial, no sessions, and the saved
  // settings take effect (that is when partial writes show their resets).
  async reboot(opts: { ms?: number; dropsConnection?: boolean } = {}): Promise<void> {
    this.counters.reboots++;
    this.rebooting = true;
    this.dropConnections();
    this.bus.emit('state', { rebooting: true });
    await this.boot(opts.ms);
    this.rebooting = false;
    this.bus.emit('state', { rebooting: false });
  }

  // Start-up after a reboot or power-on: offline for `ms`, then a new serial,
  // no sessions, and the saved settings take effect. A PTZ move stops; the
  // presets stay (not measured).
  private async boot(msOpt?: number): Promise<void> {
    this.ptz?.stop();
    const ms = Math.min(Math.max(0, Number(msOpt ?? this.timings.rebootMs) || 0), 600_000);
    await sleep(ms);
    this.serial = this.newSerial();
    this.sessions.revokeAll();
    this.settings.applySavedOnReboot();
  }

  // Power-off: every connection drops, sessions end, the recording in
  // progress is closed and background events pause. False when not on.
  powerOff(): boolean {
    if (this.power !== 'on' || this.rebooting) return false;
    this.power = 'off';
    this.ptz?.stop();
    this.events.stop();
    this.sessions.revokeAll();
    this.dropConnections();
    this.bus.emit('state', { power: 'off' });
    return true;
  }

  // Power-on: boots like a reboot. False when the camera isn't off.
  async powerOn(ms?: number): Promise<boolean> {
    if (this.power !== 'off') return false;
    this.power = 'booting';
    this.bus.emit('state', { power: 'booting' });
    await this.boot(ms);
    this.power = 'on';
    if (this.config.autoEvents.length) this.events.startAuto(this.config.autoEvents);
    this.bus.emit('state', { power: 'on' });
    return true;
  }

  // Reboot and power-off: live streams, HTTP downloads and every Baichuan
  // connection (its transfers through dropDownloads first, so they count).
  private dropConnections(): void {
    this.dropFlv();
    this.dropDownloads();
    this.baichuan?.dropAll();
  }

  dropFlv(): void {
    for (const res of this.activeFlv) res.destroy();
  }

  // HTTP downloads in flight, and Baichuan transfers (their connections close).
  dropDownloads(): void {
    for (const res of this.activeDownloads) res.destroy();
    this.baichuan?.dropTransfers();
  }

  recordRequest(r: RequestRecord): void {
    this.requests.add(r);
    this.log.debug(r, 'camera_request');
    this.bus.emit('request', r);
  }

  // Back to a known state between tests. Every part defaults to on.
  reset(what: { settings?: boolean; recordings?: boolean; counters?: boolean; faults?: boolean; video?: boolean; ptz?: boolean } = {}): void {
    const all = Object.values(what).every((v) => v === undefined);
    if (all || what.ptz) this.ptz?.reset();
    if (all || what.faults) this.faults.clearAll();
    if (all || what.settings) {
      this.settings.resetFactory();
      this.time.reset();
    }
    if (all || what.recordings) this.sd.clear();
    if (all || what.counters) this.counters.reset();
    if ((all || what.video) && this.videoId !== 'test-pattern') this.setMedia(this.mediaFor({ video: 'test-pattern' }), 'test-pattern');
    if (this.pipeline.on || this.pipeline.error) this.pipelineOff();
    this.bus.emit('state', { reset: true });
  }

  // Named states for tests (#23). clear: the content (recordings, the event
  // list, counters); settings, certificate and sessions stay.
  clear(): void {
    this.sd.clear();
    this.events.clearRecent();
    this.counters.reset();
    this.bus.emit('state', { reset: true });
  }

  // factory-reset: everything back to the factory state (settings, faults,
  // video, the factory certificate, content), pending FTP uploads dropped
  // (listeners of 'factory-reset'), then a reboot, which ends all sessions
  // and ONVIF subscriptions. False when the camera isn't on.
  factoryReset(opts: { ms?: number } = {}): boolean {
    if (this.power !== 'on' || this.rebooting) return false;
    this.reset();
    this.events.clearRecent();
    if (this.certs.state.enable !== 0 || this.certs.state.source !== 'factory') {
      this.certs.clear();
      this.bus.emit('cert', this.certs.state);
    }
    this.bus.emit('factory-reset', {});
    void this.reboot({ ms: opts.ms });
    return true;
  }

  state() {
    return {
      name: this.settings.name,
      serial: this.serial,
      model: this.profile.model,
      firmVer: this.config.firmVer,
      tz: this.config.tz,
      offline: this.offline(),
      power: this.power,
      video: this.videoId,
      rebooting: this.rebooting,
      faults: this.faults.list(),
      events: this.events.recent(20),
      sd: { usedMb: this.sd.usedMb(), capacityMb: this.config.sdMb, recordings: this.sd.count() },
      counters: { ...this.counters.snapshot(), activeSessions: this.sessions.count() },
      certificate: { source: this.certs.state.source, enable: this.certs.state.enable },
      settings: this.settings.running,
      pipeline: this.pipelineState(),
      pipelineMaxMin: this.config.pipelineMaxMin,
    };
  }

  stop(): void {
    if (this.pipeline.on) this.pipelineOff();
    this.events.stop();
    this.dropFlv();
    this.dropDownloads();
  }
}

export async function createEngine(config: CamSimConfig, deps: { clock?: Clock; media?: MediaSource; log?: pino.Logger } = {}): Promise<Engine> {
  const log = deps.log ?? createLogger(config.logLevel);
  const profile = profileFor(config.model);
  const media = deps.media ?? new FixtureMedia(await ensureFixtures(config.fixtureDir ?? defaultFixtureDir(profile), log, profile));
  const engine = new Engine(config, deps.clock ?? systemClock, log, media);
  await engine.certs.load();
  return engine;
}
