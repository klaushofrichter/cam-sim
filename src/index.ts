import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import type express from 'express';
import { createEngine, type Engine } from './engine/engine';
import { createCameraApp } from './camera-api/app';
import { createControlApp } from './control-api/app';
import { startListeners, type Listeners } from './camera-api/listeners';
import { FtpUploader } from './ftp/uploader';
import { RtspService, findMediaMtx } from './rtsp/rtsp';
import { Library } from './media/library';
import { join } from 'path';
import { tmpdir } from 'os';
import { FIRMWARE_VERSION } from './profile/version';
import type { CamSimConfig, User } from './config';
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
  mainSize?: string;
  maxVideoS?: number;
  logLevel?: string;
  log?: pino.Logger;
}

export interface Ports {
  http: number;
  https: number;
  control: number;
  rtsp: number;
}

export interface CamSim {
  engine: Engine;
  cameraApp: express.Express; // the HTTP port's app, for supertest
  controlApp: express.Express;
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
    ports: { https: 8443, http: 8080, control: 9443, rtsp: 8554 },
    logLevel: o.logLevel ?? 'silent',
    mainSize: o.mainSize ?? '4512x2512',
    maxVideoS: o.maxVideoS ?? 60,
    libraryDir: o.libraryDir,
    video: o.video,
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

  return {
    engine,
    cameraApp,
    controlApp,
    async listen(ports = {}, host) {
      const p = { ...config.ports, ...ports };
      camera = await startListeners(engine, { http: p.http, https: p.https }, host);
      // The control port uses the camera's certificate: with 'on' always (and
      // it follows ImportCertificate), with 'auto' when one was configured.
      const tls = config.controlTls === 'on' || (config.controlTls === 'auto' && !!config.tlsCertFile);
      if (tls) {
        const server = https.createServer({ cert: engine.certificate.cert, key: engine.certificate.key }, controlApp);
        const onCert = (c: { cert: string; key: string }) => server.setSecureContext({ cert: c.cert, key: c.key });
        engine.bus.on('cert', onCert);
        server.on('close', () => engine.bus.off('cert', onCert));
        control = server;
      } else control = http.createServer(controlApp);
      const srv = control;
      const controlPort = await new Promise<number>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(p.control, host, () => resolve((srv.address() as AddressInfo).port));
      });
      // RTSP through MediaMTX, when it is installed (logged and skipped otherwise).
      rtsp = new RtspService(engine, { port: p.rtsp, host, mediamtx: findMediaMtx() });
      await rtsp.start();
      if (config.autoEvents.length) engine.events.startAuto(config.autoEvents);
      preparing ??= library.prepareAll().then(() => {
        const why = config.video ? library.select(config.video) : null;
        if (why) engine.log.warn({ video: config.video, why }, 'video_not_selected');
      });
      return { ...camera.ports, control: controlPort, rtsp: rtsp.port() };
    },
    async close() {
      ftp.stop();
      library.stop();
      await preparing?.catch(() => undefined);
      await rtsp?.stop();
      engine.stop();
      await camera?.close();
      const srv = control;
      if (srv) {
        srv.closeAllConnections();
        await new Promise<void>((r) => srv.close(() => r()));
      }
    },
  };
}
