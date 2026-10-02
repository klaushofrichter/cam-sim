import { describe, it, expect, afterEach } from 'vitest';
import { startBc, closeAll, until, sleep } from './harness';
import { BcClient } from './client';
import { CLS_CAMERA } from '../../src/baichuan/frame';
import { PUSHES } from '../../src/baichuan/xml';
import { createCameraApp } from '../../src/camera-api/app';
import { login } from '../helpers';

afterEach(closeAll);

// Refused or dropped before any reply: the connect fails, or the first
// request finds the connection closed.
async function refused(connect: () => Promise<BcClient>): Promise<boolean> {
  let c: BcClient;
  try {
    c = await connect();
  } catch {
    return true;
  }
  await c.nonceRequest().catch(() => undefined);
  return c.closed && c.frames.length === 0;
}

describe('Baichuan server: the session limit (session-limit.txt)', () => {
  it('takes 12 connections, bare ones included; the 13th is reset at its first message; a close frees a slot', async () => {
    const { connect, server } = await startBc();
    const bare: BcClient[] = [];
    for (let i = 0; i < 12; i++) bare.push(await connect());
    await until(() => server.connectionCount() === 12);
    const thirteenth = await connect();
    await expect(thirteenth.nonceRequest()).rejects.toThrow(/closed/);
    expect(await thirteenth.ended).toBe('reset');
    expect(thirteenth.frames).toHaveLength(0);
    bare[0].close();
    await until(() => server.connectionCount() === 11);
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });

  it('HTTP logins work while port 9000 is full', async () => {
    const { connect, server, engine } = await startBc();
    for (let i = 0; i < 12; i++) await connect();
    await until(() => server.connectionCount() === 12);
    expect(await login(createCameraApp(engine, { port: 'http' }))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('baichuan.sessionLimit lowers the limit', async () => {
    const { connect, loggedIn, engine } = await startBc();
    engine.faults.set({ name: 'baichuan.sessionLimit', max: 2 });
    await loggedIn();
    await loggedIn();
    const third = await connect();
    await expect(third.nonceRequest()).rejects.toThrow(/closed/);
    expect(await third.ended).toBe('reset');
    engine.faults.clear('baichuan.sessionLimit');
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });
});

describe('Baichuan server: idle timeouts (idle.txt), shortened', () => {
  it('closes a connection that never sends after firstMessageMs', async () => {
    const { connect } = await startBc({ firstMessageMs: 300, idleMs: 5000 });
    const t0 = Date.now();
    const c = await connect();
    expect(await c.ended).toBe('eof');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('closes a logged-in session idleMs after its last message; cmd 93 and a 405 reset the timer', async () => {
    const { loggedIn } = await startBc({ firstMessageMs: 5000, idleMs: 600 });
    const a = await loggedIn();
    const t0 = Date.now();
    const b = await loggedIn();
    const c = await loggedIn();
    await sleep(400);
    await b.call(93);
    await c.call(4000);
    expect(await a.ended).toBe('eof');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(b.closed).toBe(false);
    expect(c.closed).toBe(false);
    expect(await b.ended).toBe('eof');
    expect(await c.ended).toBe('eof');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
});

// The push timing mirrors idle.txt (the Task 3 rulings): 78/79 0.3 s and
// 464/547 0.4 s after the login reply; the group 291/677/600/669 once per
// session, LATE_AFTER_LINK_TYPE_MS after the first client message after login
// (cmd 93 or any), or 500 ms before the idle close when no message comes.
describe('Baichuan server: pushes after login (idle.txt)', () => {
  const pushes = (c: BcClient) => c.frames.filter((f) => f.header.msgId === 0);
  const loginAt = (c: BcClient) => c.times[c.frames.findIndex((f) => f.header.cmd === 1 && f.header.status === 200)];

  it('sends 78/79 about 0.3 s and 464/547 about 0.4 s after the login reply, as AES XML with message id 0', async () => {
    const { loggedIn } = await startBc();
    const c = await loggedIn();
    await c.waitFor((f) => f.header.cmd === 547, 2000);
    const at = (cmd: number) => c.times[c.frames.findIndex((f) => f.header.cmd === cmd)] - loginAt(c);
    for (const cmd of [78, 79]) expect(at(cmd)).toBeGreaterThanOrEqual(280);
    for (const cmd of [464, 547]) expect(at(cmd)).toBeGreaterThanOrEqual(380);
    expect(at(547)).toBeLessThan(1000);
    expect(pushes(c).map((f) => f.header.cmd)).toEqual([78, 79, 464, 547]);
    for (const f of pushes(c)) {
      expect(f.header).toMatchObject({ msgId: 0, status: 200, cls: CLS_CAMERA, payloadOffset: 0 });
      expect(c.text(f)).toBe(PUSHES.find((p) => p.cmd === f.header.cmd)!.xml);
    }
  });

  it('sends the late group once, shortly after the first message after login (cmd 93)', async () => {
    const { loggedIn } = await startBc();
    const c = await loggedIn();
    await c.waitFor((f) => f.header.cmd === 547, 2000);
    await sleep(100);
    expect(pushes(c)).toHaveLength(4);
    const t0 = Date.now();
    await c.call(93);
    await c.waitFor((f) => f.header.cmd === 669, 1000);
    expect(Date.now() - t0).toBeLessThan(300);
    const late = pushes(c).slice(4);
    expect(late.map((f) => f.header.cmd)).toEqual([291, 677, 600, 669]);
    for (const f of late) expect(c.text(f)).toBe(PUSHES.find((p) => p.cmd === f.header.cmd)!.xml);
    await c.call(93);
    await c.call(4000);
    await sleep(200);
    expect(pushes(c)).toHaveLength(8);
  });

  it('any first message triggers the late group (cmd 4000 too), even before the 0.3 s pushes', async () => {
    const { loggedIn } = await startBc();
    const c = await loggedIn();
    expect((await c.call(4000)).header.status).toBe(405);
    await c.waitFor((f) => f.header.cmd === 669, 1000);
    await c.waitFor((f) => f.header.cmd === 547, 2000);
    await sleep(100);
    expect(pushes(c).map((f) => f.header.cmd).sort((a, b) => a - b)).toEqual(PUSHES.map((p) => p.cmd).sort((a, b) => a - b));
  });

  it('a burst of messages does not postpone the late group past the first one', async () => {
    const { loggedIn } = await startBc();
    const c = await loggedIn();
    await c.waitFor((f) => f.header.cmd === 547, 2000);
    const t0 = Date.now();
    let stop = false;
    const burst = (async () => {
      while (!stop) {
        c.send(93);
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await c.waitFor((f) => f.header.cmd === 669, 1000);
    const took = Date.now() - t0;
    stop = true;
    await burst;
    expect(took).toBeLessThan(30);
  });

  // idle.txt: the group at 32.514 s, the close at 32.515 s.
  it('without a message after login, the late group comes just before the idle close', async () => {
    const { loggedIn } = await startBc({ idleMs: 1200 });
    const c = await loggedIn();
    const t0 = loginAt(c);
    await c.waitFor((f) => f.header.cmd === 669, 2000);
    const groupAt = c.times[c.frames.findIndex((f) => f.header.cmd === 291)] - t0;
    expect(groupAt).toBeGreaterThanOrEqual(1150);
    expect(await c.ended).toBe('eof');
    const closedAt = Date.now() - t0;
    expect(closedAt).toBeGreaterThanOrEqual(1150);
    expect(closedAt - groupAt).toBeLessThan(50);
    expect(pushes(c).map((f) => f.header.cmd)).toEqual([78, 79, 464, 547, 291, 677, 600, 669]);
  });
});

describe('Baichuan server: the device state', () => {
  it('offline drops the connections and refuses new ones until cleared', async () => {
    const { loggedIn, connect, engine } = await startBc();
    const c = await loggedIn();
    engine.faults.set({ name: 'offline' });
    expect(['eof', 'reset']).toContain(await c.ended);
    await until(() => engine.counters.baichuanSessions === 0);
    expect(await refused(connect)).toBe(true);
    engine.faults.clear('offline');
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });

  it('power-off drops and refuses; power-on brings it back', async () => {
    const { loggedIn, connect, engine } = await startBc();
    const c = await loggedIn();
    expect(engine.powerOff()).toBe(true);
    expect(['eof', 'reset']).toContain(await c.ended);
    expect(await refused(connect)).toBe(true);
    await engine.powerOn(0);
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });

  it('reboot drops the connections and refuses new ones while booting', async () => {
    const { loggedIn, connect, engine } = await startBc();
    const c = await loggedIn();
    const booting = engine.reboot({ ms: 300 });
    expect(['eof', 'reset']).toContain(await c.ended);
    expect(await refused(connect)).toBe(true);
    await booting;
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });
});

describe('Baichuan server: cleanup', () => {
  it('baichuan.sessionLimit cannot raise the limit above 12', async () => {
    const { connect, server, engine } = await startBc();
    engine.faults.set({ name: 'baichuan.sessionLimit', max: 20 });
    for (let i = 0; i < 12; i++) await connect();
    await until(() => server.connectionCount() === 12);
    const thirteenth = await connect();
    await expect(thirteenth.nonceRequest()).rejects.toThrow(/closed/);
    expect(await thirteenth.ended).toBe('reset');
  });

  // Review Focus 2: the server's own close ends every connection and timer.
  it('close() ends logged-in, bare and over-limit connections at once', async () => {
    const { connect, loggedIn, server, engine } = await startBc();
    const clients = [await loggedIn(), await loggedIn('viewer', 'viewer-pw'), await connect()];
    await until(() => server.connectionCount() === 3);
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    for (const c of clients) expect(['eof', 'reset']).toContain(await c.ended);
    expect(server.connectionCount()).toBe(0);
    expect(engine.counters.baichuanSessions).toBe(0);
    expect(engine.sessions.online()).toEqual([]);
    expect(engine.baichuan).toBeUndefined();
    await server.close(); // twice is harmless
  });

  // Review Focus 3.
  it('a client that vanishes leaves no session behind', async () => {
    const { loggedIn, server, engine } = await startBc();
    const c = await loggedIn();
    c.socket.resetAndDestroy();
    await until(() => server.connectionCount() === 0);
    expect(engine.counters.baichuanSessions).toBe(0);
    expect(engine.sessions.online()).toEqual([]);
  });

  // Unmeasured: the session ends with its connection, not with a user change.
  it('a session survives a later delete of its user', async () => {
    const { loggedIn, engine } = await startBc();
    const c = await loggedIn('viewer', 'viewer-pw');
    expect(engine.sessions.delUser('viewer')).toBeNull();
    expect((await c.call(93)).header.status).toBe(200);
    expect(engine.sessions.online().map((u) => u.userName)).toEqual(['viewer']);
  });
});
