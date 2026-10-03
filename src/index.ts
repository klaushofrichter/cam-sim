import http from 'http';
import https from 'https';
import type express from 'express';
import { createEngine, type Engine } from './engine/engine';
import { createCameraApp } from './camera-api/app';
import { createControlApp } from './control-api/app';
import { startListeners, type Listeners } from './camera-api/listeners';
import { FtpUploader } from './ftp/uploader';
import { RtspService, findMediaMtx } from './rtsp/rtsp';
import { Library } from './media/library';
import { SdPipeline } from './pipeline/sd-pipeline';
import { findFonts } from './pipeline/fonts';
import { BaichuanServer, type BaichuanOptions } from './baichuan/server';
import { createOnvifApp, type OnvifApp } from './onvif/server';
import { join } from 'path';
import { tmpdir } from 'os';
import { FIRMWARE_VERSION } from './profile/version';
import { closeServer, followCertificate, listen } from './util/net';
import type { CamSimConfig, User } from './config';
import { BAICHUAN_FIRST_MESSAGE_MS, BAICHUAN_IDLE_MS } from './config';
import type { Clock } from './engine/clock';
import type { FaultSpec } from './engine/faults';
import type { SeedClip, Trigger } from './engine/sdcard';
import type pino from 'pino';

export { DEMO_CLIPS } from './engine/sdcard';
// For test runners: build the fixtures once before workers start (globalSetup).
export { ensureFixtures, defaultFixtureDir } from './media/fixtures';
export type { FaultSpec, SeedClip, Trigger, User, Engine, CamSimConfig };

export interface CamSimOptions {
  users: User[];
  name?: string;
  controlToken?: string;
  controlTls?: 'auto' | 'on' | 'off';
  tz?: string;
  sdMb?: number;
  speed?: 'fast' | 'real';
  firmVer?: string;
  seed?: number;
  dataDir?: string; // omit: nothing is written to disk
  faults?: FaultSpec[];
  seedClips?: 'demo' | SeedClip[];
  autoEvents?: CamSimConfig['autoEvents'];
  reboot?: { ms?: number; dropsConnection?: boolean };
  tlsCertFile?: string;
  tlsKeyFile?: string;
  clock?: Clock;
  fixtureDir?: string;
  libraryDir?: string; // videos to offer besides the test pattern
  video?: string; // selected once it is ready
  pipelineMaxMin?: number; // the longest SD pipeline switch-on (minutes, default 1440)
  fontDir?: string; // fonts for the SD pipeline (default: system DejaVu, or Arial on a Mac)
  mainSize?: string;
  maxVideoS?: number;
  logLevel?: string;
  log?: pino.Logger;
  baichuan?: BaichuanOptions; // shorter Baichuan idle closes, for tests
}

export interface Ports {
  http: number;
  https: number;
  control: number;
  rtsp: number;
  onvif: number;
  baichuan?: number; // absent when Baichuan is off (the CLI without CAMSIM_BAICHUAN_PORT)
}

export interface CamSim {
  engine: Engine;
  cameraApp: express.Express; // the HTTP port's app, for supertest
  controlApp: express.Express;
  // If a listener fails to bind, the ones already opened are closed and the
  // error is rethrown; the instance is stopped then: create a new one.
  listen(ports?: Partial<Ports>, host?: string): Promise<Ports>;
  close(): Promise<void>;
}

export function configFromOptions(o: CamSimOptions): CamSimConfig {
  return {
    name: o.name ?? 'Cam',
    users: o.users,
    controlToken: o.controlToken,
    webUi: false,
    controlTls: o.controlTls ?? 'auto',
    media: 'fixture',
    dataDir: o.dataDir,
    fixtureDir: o.fixtureDir,
    tz: o.tz ?? 'America/Chicago',
    sdMb: o.sdMb ?? 4096,
    speed: o.speed ?? 'fast',
    seedClips: o.seedClips === 'demo' ? 'demo' : 'none',
    faults: o.faults ?? [],
    autoEvents: o.autoEvents ?? [],
    firmVer: o.firmVer ?? FIRMWARE_VERSION,
    seed: o.seed ?? Date.now() % 2 ** 31,
    tlsCertFile: o.tlsCertFile,
    tlsKeyFile: o.tlsKeyFile,
    // In process the Baichuan port defaults to a free one: callers that don't
    // name it (cams' and cam-proxy's tests, in parallel) never collide on 9000.
    ports: { https: 8443, http: 8080, control: 9443, rtsp: 8554, onvif: 8000, baichuan: 0 },
    baichuan: { idleMs: o.baichuan?.idleMs ?? BAICHUAN_IDLE_MS, firstMessageMs: o.baichuan?.firstMessageMs ?? BAICHUAN_FIRST_MESSAGE_MS },
    logLevel: o.logLevel ?? 'silent',
    mainSize: o.mainSize ?? '4512x2512',
    maxVideoS: o.maxVideoS ?? 60,
    libraryDir: o.libraryDir,
    video: o.video,
    pipelineMaxMin: o.pipelineMaxMin ?? 1440,
    fontDir: o.fontDir,
  };
}

// A simulated camera in this process: the engine plus its apps. `listen`
// opens the camera's HTTP and HTTPS ports and the control port.
export async function createCamSim(opts: CamSimOptions, config: CamSimConfig = configFromOptions(opts)): Promise<CamSim> {
  const engine = await createEngine(config, { clock: opts.clock, log: opts.log });
  if (Array.isArray(opts.seedClips)) engine.sd.seed(opts.seedClips);
  if (opts.reboot) engine.rebootDefaults = { ...opts.reboot };
  const cameraApp = createCameraApp(engine, { port: 'http' });
  const controlApp = createControlApp(engine);
  // Uploads finished recordings when FTP is enabled (SetFtpV20 or CAMSIM_FTP_*).
  const ftp = new FtpUploader(engine);
  // The video library; cached next to the data (or in the temp folder).
  const library = new Library(engine, { sourceDir: config.libraryDir, cacheDir: config.dataDir ? join(config.dataDir, 'library') : join(tmpdir(), 'cam-sim-library') });
  let preparing: Promise<void> | undefined;
  let camera: Listeners | undefined;
  let control: http.Server | https.Server | undefined;
  let rtsp: RtspService | undefined;
  let pipeline: SdPipeline | undefined;
  let onvif: http.Server | undefined;
  let onvifApp: OnvifApp | undefined;
  let baichuan: BaichuanServer | undefined;

  // Opens every listener in turn. Anything opened before a failure stays open
  // here; listen() below closes it.
  async function openAll(ports: Partial<Ports>, host?: string): Promise<Ports> {
    const p = { ...config.ports, ...ports };
    camera = await startListeners(engine, { http: p.http, https: p.https }, host);
    // The control port uses the camera's certificate: with 'on' always (and
    // it follows ImportCertificate), with 'auto' when one was configured.
    const tls = config.controlTls === 'on' || (config.controlTls === 'auto' && !!config.tlsCertFile);
    if (tls) {
      const server = https.createServer({ cert: engine.certs.state.cert, key: engine.certs.state.key }, controlApp);
      server.on('close', followCertificate(engine, server));
      control = server;
    } else control = http.createServer(controlApp);
    const controlPort = await listen(control, p.control, host);
    // ONVIF (device and event services), plain HTTP as on the camera.
    onvifApp = createOnvifApp(engine);
    onvif = http.createServer(onvifApp);
    const onvifPort = await listen(onvif, p.onvif, host);
    // Baichuan (the camera's port 9000): login and recordings download.
    // Off when the config has no port (CLI without CAMSIM_BAICHUAN_PORT) and
    // listen() doesn't name one.
    let baichuanPort: number | undefined;
    if (p.baichuan != null) {
      baichuan = new BaichuanServer(engine);
      baichuanPort = await baichuan.listen(p.baichuan, host);
    }
    // RTSP through MediaMTX, when it is installed (logged and skipped otherwise).
    rtsp = new RtspService(engine, { port: p.rtsp, host, mediamtx: findMediaMtx() });
    await rtsp.start();
    // The optional SD pipeline (off until switched on; spec 2026-09-29).
    pipeline = new SdPipeline(engine, {
      fonts: findFonts(config.fontDir),
      rtspUrl: () => rtsp?.publisherUrl('sub'),
      onProcess: (up) => rtsp?.setSubSource(up ? 'pipeline' : 'copy'),
    });
    rtsp.onDropReaders(() => pipeline?.restartNow());
    if (config.autoEvents.length) engine.events.startAuto(config.autoEvents);
    preparing ??= library.prepareAll().then(() => {
      const why = config.video ? library.select(config.video) : null;
      if (why) engine.log.warn({ video: config.video, why }, 'video_not_selected');
    });
    return { ...camera.ports, control: controlPort, rtsp: rtsp.port(), onvif: onvifPort, ...(baichuanPort === undefined ? {} : { baichuan: baichuanPort }) };
  }

  async function shutdown(): Promise<void> {
    ftp.stop();
    library.stop();
    await preparing?.catch(() => undefined);
    await pipeline?.stop();
    await rtsp?.stop();
    await baichuan?.close();
    onvifApp?.stop();
    engine.stop();
    await camera?.close();
    for (const srv of [control, onvif]) if (srv) await closeServer(srv);
  }

  return {
    engine,
    cameraApp,
    controlApp,
    // A listener that fails to bind (EADDRINUSE) must not leave the ones
    // opened before it running: close them all, then rethrow.
    async listen(ports = {}, host) {
      try {
        return await openAll(ports, host);
      } catch (err) {
        await shutdown().catch(() => undefined);
        throw err;
      }
    },
    close: shutdown,
  };
}
