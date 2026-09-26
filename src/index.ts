import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import type express from 'express';
import { createEngine, type Engine } from './engine/engine';
import { createCameraApp } from './camera-api/app';
import { createControlApp } from './control-api/app';
import { startListeners, type Listeners } from './camera-api/listeners';
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
  logLevel?: string;
  log?: pino.Logger;
}

export interface Ports {
  http: number;
  https: number;
  control: number;
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
    ports: { https: 8443, http: 8080, control: 9443 },
    logLevel: o.logLevel ?? 'silent',
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
  let camera: Listeners | undefined;
  let control: http.Server | https.Server | undefined;

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
      if (config.autoEvents.length) engine.events.startAuto(config.autoEvents);
      return { ...camera.ports, control: controlPort };
    },
    async close() {
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
