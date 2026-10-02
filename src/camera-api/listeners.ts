import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import type { Engine } from '../engine/engine';
import type { CertState } from '../tls/certs';
import { createCameraApp } from './app';

export interface Listeners {
  http: http.Server;
  https: https.Server;
  ports: { http: number; https: number };
  close(): Promise<void>;
}

function listen(server: http.Server | https.Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

// The camera's two ports. A new certificate (ImportCertificate,
// CertificateClear) applies to new TLS connections without a restart.
export async function startListeners(engine: Engine, ports: { http: number; https: number }, host?: string): Promise<Listeners> {
  const httpServer = http.createServer(createCameraApp(engine, { port: 'http' }));
  const cert = engine.certificate;
  const httpsServer = https.createServer({ cert: cert.cert, key: cert.key }, createCameraApp(engine, { port: 'https' }));
  const onCert = (c: CertState) => httpsServer.setSecureContext({ cert: c.cert, key: c.key });
  engine.bus.on('cert', onCert);
  const close = (s: http.Server | https.Server) =>
    new Promise<void>((r) => {
      s.closeAllConnections();
      s.close(() => r());
    });
  // If the second port fails to bind, the first must not stay open.
  let bound: { http: number; https: number };
  try {
    bound = { http: await listen(httpServer, ports.http, host), https: await listen(httpsServer, ports.https, host) };
  } catch (err) {
    engine.bus.off('cert', onCert);
    await Promise.all([close(httpServer), close(httpsServer)]);
    throw err;
  }
  return {
    http: httpServer,
    https: httpsServer,
    ports: bound,
    close: async () => {
      engine.bus.off('cert', onCert);
      engine.dropFlv();
      engine.dropDownloads();
      await Promise.all([close(httpServer), close(httpsServer)]);
    },
  };
}
