import type pino from 'pino';
import { makeEngine } from '../helpers';
import { BaichuanServer } from '../../src/baichuan/server';
import { BcClient } from './client';
import type { Clock } from '../../src/engine/clock';

// admin, a second admin for HTTP (`login()`'s default), proxy (admin level on
// the real camera) and a guest.
export const BC_USERS = 'admin:admin:admin-pw;cams:admin:cams-pw;proxy:admin:proxy-pw;viewer:guest:viewer-pw';
export const DEMO = { CAMSIM_SEED_CLIPS: 'demo' };

const closers: Array<() => Promise<void> | void> = [];
export function track(fn: () => Promise<void> | void): void {
  closers.push(fn);
}
export async function closeAll(): Promise<void> {
  while (closers.length) await closers.pop()!();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(f: () => boolean, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !f(); await sleep(10)) if (Date.now() - t0 > ms) throw new Error('timed out');
}

export async function startBc(opts: { env?: Record<string, string>; idleMs?: number; firstMessageMs?: number; clock?: Clock; log?: pino.Logger } = {}) {
  const deps: { clock?: Clock; log?: pino.Logger } = {};
  if (opts.clock) deps.clock = opts.clock;
  if (opts.log) deps.log = opts.log;
  const engine = await makeEngine({ CAMSIM_USERS: BC_USERS, ...opts.env }, deps);
  const server = new BaichuanServer(engine, { idleMs: opts.idleMs, firstMessageMs: opts.firstMessageMs });
  const port = await server.listen(0, '127.0.0.1');
  const clients: BcClient[] = [];
  const connect = async () => {
    const c = await BcClient.connect(port);
    clients.push(c);
    return c;
  };
  const loggedIn = async (user = 'proxy', password = 'proxy-pw') => {
    const c = await connect();
    const r = await c.login(user, password);
    if (r.header.status !== 200) throw new Error(`login answered ${r.header.status}`);
    return c;
  };
  track(async () => {
    for (const c of clients) c.close();
    await server.close();
  });
  return { engine, server, port, connect, loggedIn };
}
