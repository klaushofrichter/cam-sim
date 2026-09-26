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
  readonly sessions: Sessions;
  readonly settings: SettingsStore;
  readonly sd: SdCard;
  readonly events: Events;
  readonly rng: Rng;
  serial: string;
  rebooting = false;
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
    return this.rebooting || !!this.faults.active('offline');
  }

  // Reboot: offline for `ms`, then a new serial, no sessions, and the saved
  // settings take effect (that is when partial writes show their resets).
  async reboot(opts: { ms?: number; dropsConnection?: boolean } = {}): Promise<void> {
    this.counters.reboots++;
    this.rebooting = true;
    this.dropFlv();
    this.dropDownloads();
    this.bus.emit('state', { rebooting: true });
    await new Promise((r) => setTimeout(r, opts.ms ?? this.timings.rebootMs));
    this.serial = this.newSerial();
    this.sessions.revokeAll();
    this.settings.applySavedOnReboot();
    this.rebooting = false;
    this.bus.emit('state', { rebooting: false });
  }

  dropFlv(): void {
    for (const res of this.activeFlv) res.destroy();
  }

  dropDownloads(): void {
    for (const res of this.activeDownloads) res.destroy();
  }

  recordRequest(r: RequestRecord): void {
    this.bus.emit('request', r);
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
  return new Engine(config, deps.clock ?? systemClock, log, media);
}
