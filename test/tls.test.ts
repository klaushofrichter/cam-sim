import { describe, it, expect, afterEach } from 'vitest';
import tls from 'tls';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generate } from 'selfsigned';
import { makeEngine, post, login } from './helpers';
import { createCameraApp } from '../src/camera-api/app';
import { startListeners, type Listeners } from '../src/camera-api/listeners';
import type { Engine } from '../src/engine/engine';

const open: Listeners[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function start(env: Record<string, string> = {}) {
  const engine = await makeEngine(env);
  const l = await startListeners(engine, { http: 0, https: 0 });
  open.push(l);
  return { engine, l, app: createCameraApp(engine, { port: 'https' }) };
}

function peerCN(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'cam2.skylar.technology' }, () => {
      const cn = s.getPeerCertificate().subject?.CN;
      s.end();
      resolve(String(cn));
    });
    s.on('error', reject);
  });
}

async function camCert() {
  const p = await generate([{ name: 'commonName', value: 'cam2.skylar.technology' }], { keySize: 2048, algorithm: 'sha256' });
  return { cert: p.cert, key: p.private };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const importParam = (c: { cert: string; key: string }) => ({
  importCertificate: {
    crt: { size: Buffer.byteLength(c.cert), name: 'server.crt', content: b64(c.cert) },
    key: { size: Buffer.byteLength(c.key), name: 'server.key', content: b64(c.key) },
  },
});

async function waitOnline(engine: Engine) {
  while (engine.offline()) await new Promise((r) => setTimeout(r, 20));
}

describe('TLS and certificates', () => {
  it('serves the factory certificate CN=CERTIFICATE by default', async () => {
    const { l, app } = await start();
    expect(await peerCN(l.ports.https)).toBe('CERTIFICATE');
    const t = await login(app);
    expect((await post(app, 'GetCertificateInfo', {}, t)).reply.value).toEqual({ CertificateInfo: { crtName: 'server.crt', enable: 0, keyName: 'server.key' } });
  });

  it('Clear, then Import: the new certificate is served without a restart', async () => {
    const { l, app, engine } = await start();
    const c = await camCert();
    let t = await login(app);
    expect((await post(app, 'ImportCertificate', importParam(c), t)).reply).toEqual({ cmd: 'ImportCertificate', code: 0, value: { rspCode: 200 } });
    await waitOnline(engine);
    t = await login(app);
    expect(await peerCN(l.ports.https)).toBe('cam2.skylar.technology');
    expect((await post(app, 'GetCertificateInfo', {}, t)).reply.value.CertificateInfo.enable).toBe(1);

    // Importing over an installed certificate answers 200 and changes nothing.
    const p2 = await generate([{ name: 'commonName', value: 'cam3.skylar.technology' }], { keySize: 2048 });
    expect((await post(app, 'ImportCertificate', importParam({ cert: p2.cert, key: p2.private }), t)).reply.code).toBe(0);
    expect(await peerCN(l.ports.https)).toBe('cam2.skylar.technology');

    expect((await post(app, 'CertificateClear', {}, t)).reply.code).toBe(0);
    expect(engine.offline()).toBe(true);
    await waitOnline(engine);
    expect((await post(app, 'GetDevInfo', {}, t)).reply.error.rspCode).toBe(-6); // log in again
    expect(await peerCN(l.ports.https)).toBe('CERTIFICATE');
    t = await login(app);
    await post(app, 'ImportCertificate', importParam({ cert: p2.cert, key: p2.private }), t);
    await waitOnline(engine);
    expect(await peerCN(l.ports.https)).toBe('cam3.skylar.technology');
  });

  it('rejects a certificate whose key does not match with -4', async () => {
    const { app } = await start();
    const a = await camCert(), b = await camCert();
    const t = await login(app);
    expect((await post(app, 'ImportCertificate', importParam({ cert: a.cert, key: b.key }), t)).reply.error.rspCode).toBe(-4);
    expect((await post(app, 'ImportCertificate', { importCertificate: { crt: { content: 'bm9wZQ==' }, key: { content: 'bm9wZQ==' } } }, t)).reply.error.rspCode).toBe(-4);
  });

  it('uses CAMSIM_TLS_CERT_FILE / KEY_FILE when set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camsim-tls-'));
    const c = await camCert();
    writeFileSync(join(dir, 'c.pem'), c.cert);
    writeFileSync(join(dir, 'k.pem'), c.key);
    const { l } = await start({ CAMSIM_TLS_CERT_FILE: join(dir, 'c.pem'), CAMSIM_TLS_KEY_FILE: join(dir, 'k.pem') });
    expect(await peerCN(l.ports.https)).toBe('cam2.skylar.technology');
  });

  it('keeps an imported certificate across restarts with a data dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camsim-tls-'));
    const { app, engine } = await start({ CAMSIM_DATA_DIR: dir });
    const t = await login(app);
    await post(app, 'ImportCertificate', importParam(await camCert()), t);
    await waitOnline(engine);
    const again = await start({ CAMSIM_DATA_DIR: dir });
    expect(await peerCN(again.l.ports.https)).toBe('cam2.skylar.technology');
    expect(again.engine.certificate.enable).toBe(1);
  });

  it('httpsEnable 0 resets HTTPS while HTTP answers', async () => {
    const { l, app } = await start();
    const t = await login(app);
    const np = (await post(app, 'GetNetPort', {}, t)).reply.value.NetPort;
    await post(app, 'SetNetPort', { NetPort: { ...np, httpsEnable: 0 } }, t);
    const res = await fetch(`http://127.0.0.1:${l.ports.http}/cgi-bin/api.cgi?cmd=Snap`);
    expect(res.status).toBe(200);
    await expect(new Promise((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: l.ports.https, rejectUnauthorized: false }, () => {
        s.write('GET /cgi-bin/api.cgi?cmd=Snap HTTP/1.1\r\nHost: x\r\n\r\n');
      });
      s.on('data', () => resolve('answered'));
      s.on('error', reject);
      s.on('close', () => resolve('closed'));
    })).resolves.toBe('closed');
  });
});
