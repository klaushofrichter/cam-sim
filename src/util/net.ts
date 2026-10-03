import type http from 'http';
import type https from 'https';
import type { AddressInfo } from 'net';
import type { Engine } from '../engine/engine';
import type { CertState } from '../tls/certs';

// Binds and answers the port it got (0: a free one); rejects on a bind error.
export function listen(server: http.Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

// Closes now: open keep-alive and streaming connections don't hold it up.
export function closeServer(server: http.Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

// A new camera certificate (ImportCertificate, CertificateClear) applies to
// new TLS connections without a restart. Returns the unsubscribe.
export function followCertificate(engine: Engine, server: https.Server): () => void {
  const onCert = (c: CertState) => server.setSecureContext({ cert: c.cert, key: c.key });
  engine.bus.on('cert', onCert);
  return () => engine.bus.off('cert', onCert);
}
