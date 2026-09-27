import { EventEmitter } from 'events';
import { join } from 'path';
import type pino from 'pino';
import type { Response } from 'express';
import type { CamSimConfig } from '../config';
import { systemClock, type Clock } from './clock';
import { createRng, type Rng } from './rng';
import { Sessions } from './sessions';
import { SettingsStore } from './settings';
import { SdCard, DEMO_CLIPS } from './sdcard';
import { Events } from './events';
import { Faults } from './faults';
import { Counters } from './counters';
import type { MediaSource } from '../media/source';
import { ensureFixtures, defaultFixtureDir, FixtureMedia } from '../media/fixtures';
import { createLogger } from '../log';
import { Certificates, type CertState } from '../tls/certs';
import { RequestLog } from './request-log';

// Measured timings (CAMSIM_SPEED=real) and their fast stand-ins.
const TIMINGS = {
  real: { rebootMs: 60_000, searchMs: 300, loginMs: 200, downloadBytesPerS: 150 * 1024, certRestartMs: 10_000 },
  fast: { rebootMs: 1_000, searchMs: 20, loginMs: 0, downloadBytesPerS: 0, certRestartMs: 200 },
};

export interface RequestRecord {
  at: string;
  port: 'http' | 'https';
  method: string;
  path: string;
  cmd: string;
  status: number;
  ms: number;
}

// One simulated camera: every surface (camera API, control API, in-process
// tests) works on this object.
export class Engine {
  readonly bus = new EventEmitter();
  readonly faults = new Faults();
  readonly counters = new Counters();
  readonly requests = new RequestLog();
  readonly sessions: Sessions;
  readonly settings: SettingsStore;
  readonly sd: SdCard;
  readonly events: Events;
  readonly rng: Rng;
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

  constructor(
    readonly config: CamSimConfig,
    readonly clock: Clock,
    readonly log: pino.Logger,
    readonly media: MediaSource,
  ) {
    this.rng = createRng(config.seed);
    this.certs = new Certificates({ certFile: config.tlsCertFile, keyFile: config.tlsKeyFile, dataDir: config.dataDir });
    this.serial = this.newSerial();
    this.sessions = new Sessions(config.users, clock);
    this.settings = new SettingsStore({ name: config.name, file: config.dataDir && join(config.dataDir, 'settings.json'), log });
    this.sd = new SdCard({
      dir: config.dataDir && join(config.dataDir, 'sd'),
      capacityMb: config.sdMb,
      clock,
      tz: config.tz,
      log,
      fixtureSizes: { sub: media.clipSize('sub'), main: media.clipSize('main') },
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

  offline(): boolean {
    return this.power !== 'on' || this.rebooting || this.certRestarting || !!this.faults.active('offline');
  }

  get certificate(): CertState {
    return this.certs.state;
  }

  // CertificateClear and a successful ImportCertificate restart the camera's
  // web server: sessions end, and clients must log in again.
  private async certRestart(): Promise<void> {
    this.bus.emit('cert', this.certs.state);
    this.sessions.revokeAll();
    this.certRestarting = true;
    await new Promise((r) => setTimeout(r, this.timings.certRestartMs));
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
    this.dropFlv();
    this.dropDownloads();
    this.bus.emit('state', { rebooting: true });
    await this.boot(opts.ms);
    this.rebooting = false;
    this.bus.emit('state', { rebooting: false });
  }

  // Start-up after a reboot or power-on: offline for `ms`, then a new serial,
  // no sessions, and the saved settings take effect.
  private async boot(msOpt?: number): Promise<void> {
    const ms = Math.min(Math.max(0, Number(msOpt ?? this.timings.rebootMs) || 0), 600_000);
    await new Promise((r) => setTimeout(r, ms));
    this.serial = this.newSerial();
    this.sessions.revokeAll();
    this.settings.applySavedOnReboot();
  }

  // Power-off: every connection drops, sessions end, the recording in
  // progress is closed and background events pause. False when not on.
  powerOff(): boolean {
    if (this.power !== 'on' || this.rebooting) return false;
    this.power = 'off';
    this.events.stop();
    this.sessions.revokeAll();
    this.dropFlv();
    this.dropDownloads();
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

  dropFlv(): void {
    for (const res of this.activeFlv) res.destroy();
  }

  dropDownloads(): void {
    for (const res of this.activeDownloads) res.destroy();
  }

  recordRequest(r: RequestRecord): void {
    this.requests.add(r);
    this.log.debug(r, 'camera_request');
    this.bus.emit('request', r);
  }

  // Back to a known state between tests. Every part defaults to on.
  reset(what: { settings?: boolean; recordings?: boolean; counters?: boolean; faults?: boolean } = {}): void {
    const all = Object.values(what).every((v) => v === undefined);
    if (all || what.faults) this.faults.clearAll();
    if (all || what.settings) this.settings.resetFactory();
    if (all || what.recordings) this.sd.clear();
    if (all || what.counters) this.counters.reset();
    this.bus.emit('state', { reset: true });
  }

  state() {
    return {
      name: this.config.name,
      serial: this.serial,
      model: 'RLC-1224A',
      firmVer: this.config.firmVer,
      tz: this.config.tz,
      offline: this.offline(),
      power: this.power,
      rebooting: this.rebooting,
      faults: this.faults.list(),
      events: this.events.recent(20),
      sd: { usedMb: this.sd.usedMb(), capacityMb: this.config.sdMb, recordings: this.sd.all().length },
      counters: { ...this.counters.snapshot(), activeSessions: this.sessions.count() },
      certificate: { source: this.certificate.source, enable: this.certificate.enable },
      settings: this.settings.running,
    };
  }

  stop(): void {
    this.events.stop();
    this.dropFlv();
    this.dropDownloads();
  }
}

export async function createEngine(config: CamSimConfig, deps: { clock?: Clock; media?: MediaSource; log?: pino.Logger } = {}): Promise<Engine> {
  const log = deps.log ?? createLogger(config.logLevel);
  const media = deps.media ?? new FixtureMedia(await ensureFixtures(config.fixtureDir ?? defaultFixtureDir(), log));
  const engine = new Engine(config, deps.clock ?? systemClock, log, media);
  await engine.certs.load();
  return engine;
}
