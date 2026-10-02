import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createEngine, type Engine } from '../src/engine/engine';
import { createCameraApp } from '../src/camera-api/app';
import { loadConfig, type CamSimConfig } from '../src/config';
import { createLogger } from '../src/log';
import type { Clock } from '../src/engine/clock';
import type pino from 'pino';

export const USERS = 'admin:admin:admin-pw;cams:admin:cams-pw';

export async function makeEngine(env: Record<string, string> = {}, deps: { clock?: Clock; log?: pino.Logger } = {}): Promise<Engine> {
  const config: CamSimConfig = loadConfig({ CAMSIM_USERS: USERS, CAMSIM_SEED: '1', ...env });
  return createEngine(config, { log: createLogger('silent'), ...deps });
}

export async function makeCamera(env: Record<string, string> = {}, deps: { clock?: Clock } = {}) {
  const engine = await makeEngine(env, deps);
  const app = createCameraApp(engine, { port: 'http' });
  return { engine, app };
}

export async function post(app: Parameters<typeof request>[0], cmd: string, param: unknown = {}, token?: string) {
  const res = await request(app)
    .post(`/cgi-bin/api.cgi?cmd=${cmd}${token ? `&token=${token}` : ''}`)
    .set('Content-Type', 'application/json')
    .send([{ cmd, action: 0, param }]);
  // Issue #57: say what came back when it is not the camera's JSON (an empty
  // reply, another server's answer), not just "Unexpected end of JSON input".
  let reply: any;
  try {
    reply = JSON.parse(res.text)[0];
  } catch {
    throw new Error(`${cmd}: the reply is not JSON: HTTP ${res.status}, content-type ${res.headers['content-type']}, body ${JSON.stringify(String(res.text).slice(0, 300))}`);
  }
  return { res, reply };
}

export async function login(app: Parameters<typeof request>[0], user = 'cams', password = 'cams-pw'): Promise<string> {
  const { reply } = await post(app, 'Login', { User: { Version: '0', userName: user, password } });
  if (reply.code !== 0) throw new Error(`login failed: ${JSON.stringify(reply)}`);
  return reply.value.Token.name;
}

// A real listening server, for streaming and connection-reset checks.
export async function listen(app: http.RequestListener): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

// GET that resolves with status/headers/first bytes, or 'reset' when the
// server destroys the socket without answering.
export function rawGet(url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer } | 'reset'> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        n += c.length;
        if (opts.maxBytes && n >= opts.maxBytes) {
          req.destroy();
          done();
        }
      });
      res.on('end', done);
      res.on('error', () => done());
    });
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || /socket hang up/.test(e.message) ? resolve('reset') : reject(e)));
    req.setTimeout(opts.timeoutMs ?? 5000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}
