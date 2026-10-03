import http from 'http';
import https from 'https';
import type { Engine } from '../engine/engine';
import { closeServer, followCertificate, listen } from '../util/net';
import { createCameraApp } from './app';

export interface Listeners {
  http: http.Server;
  https: https.Server;
  ports: { http: number; https: number };
  close(): Promise<void>;
}

// The camera's two ports. A new certificate (ImportCertificate,
// CertificateClear) applies to new TLS connections without a restart.
export async function startListeners(engine: Engine, ports: { http: number; https: number }, host?: string): Promise<Listeners> {
  const httpServer = http.createServer(createCameraApp(engine, { port: 'http' }));
  const cert = engine.certs.state;
  const httpsServer = https.createServer({ cert: cert.cert, key: cert.key }, createCameraApp(engine, { port: 'https' }));
  const unfollow = followCertificate(engine, httpsServer);
  // If the second port fails to bind, the first must not stay open.
  let bound: { http: number; https: number };
  try {
    bound = { http: await listen(httpServer, ports.http, host), https: await listen(httpsServer, ports.https, host) };
  } catch (err) {
    unfollow();
    await Promise.all([closeServer(httpServer), closeServer(httpsServer)]);
    throw err;
  }
  return {
    http: httpServer,
    https: httpsServer,
    ports: bound,
    close: async () => {
      unfollow();
      engine.dropFlv();
      engine.dropDownloads();
      await Promise.all([closeServer(httpServer), closeServer(httpsServer)]);
    },
  };
}
