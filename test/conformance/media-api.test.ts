import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import { makeCamera, post, login, listen, rawGet } from '../helpers';
import { readFlv } from '../../src/media/flv';
import { createCameraApp } from '../../src/camera-api/app';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function served(env: Record<string, string> = {}) {
  const cam = await makeCamera(env);
  const srv = await listen(cam.app);
  closers.push(srv.close);
  closers.push(async () => cam.engine.stop());
  const t = await login(cam.app);
  const flv = (stream: string, token = t) => `${srv.url}/flv?port=1935&app=bcs&stream=channel0_${stream}.bcs&token=${token}`;
  return { ...cam, srv, t, flv };
}

describe('camera API: Snap', () => {
  it('serves a JPEG', async () => {
    const { app, t } = await served();
    const res = await request(app).get(`/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=abc&token=${t}`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('answers a bad token with 200 text/html carrying -6', async () => {
    const { app } = await served();
    const res = await request(app).get('/cgi-bin/api.cgi?cmd=Snap&channel=0&token=deadbeefdeadbeef');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toBe('[{"code":1,"error":{"rspCode":-6,"detail":"please login first"}}]');
  });

  it('snap.fail answers 500', async () => {
    const { app, t, engine } = await served();
    engine.faults.set({ name: 'snap.fail' });
    expect((await request(app).get(`/cgi-bin/api.cgi?cmd=Snap&token=${t}`)).status).toBe(500);
  });
});

describe('camera API: FLV live', () => {
  it('streams the sub stream (H.264) and main stream (codec id 12)', async () => {
    const { flv, engine } = await served();
    for (const [stream, codec] of [['sub', 7], ['main', 12]] as const) {
      const r = await rawGet(flv(stream), { maxBytes: 4096 });
      if (r === 'reset') throw new Error('reset');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('video/x-flv');
      expect(r.body.subarray(0, 3).toString()).toBe('FLV');
      expect(readFlv(r.body).tags.find((x) => x.type === 9)?.codecId).toBe(codec);
    }
    expect(engine.counters.streamsOpened).toBe(2);
  });

  it('resets on a bad token, flv.reset, or RTMP off', async () => {
    const { app, t, flv, engine } = await served();
    expect(await rawGet(flv('sub', 'deadbeefdeadbeef'))).toBe('reset');
    engine.faults.set({ name: 'flv.reset' });
    expect(await rawGet(flv('sub'))).toBe('reset');
    engine.faults.clear('flv.reset');
    const np = (await post(app, 'GetNetPort', {}, t)).reply.value.NetPort;
    await post(app, 'SetNetPort', { NetPort: { ...np, rtmpEnable: 0 } }, t);
    expect(await rawGet(flv('sub'))).toBe('reset');
  });

  it('never ends: loops the fixture with increasing timestamps', async () => {
    const { flv, engine } = await served();
    const dur = engine.media.durationMs('sub');
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const req = http.get(flv('sub'), (res) => {
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => reject(new Error('the stream ended')));
      });
      req.on('error', () => undefined);
      setTimeout(() => {
        req.destroy();
        resolve(Buffer.concat(chunks));
      }, dur + 1500);
    });
    const tags = readFlv(body).tags;
    const ms = tags.map((t) => t.ms);
    expect(Math.max(...ms)).toBeGreaterThan(dur);
    expect(ms.slice(1).every((m, i) => m >= ms[i] - 200)).toBe(true); // no jump back to 0
  }, 20_000);

  it('counts active streams and drops them on request', async () => {
    const { flv, engine } = await served();
    const p = rawGet(flv('sub'), { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.counters.activeStreams).toBe(1);
    engine.dropFlv();
    await p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.counters.activeStreams).toBe(0);
  });
});

describe('camera API: availability', () => {
  it('offline destroys every connection', async () => {
    const { srv, engine } = await served();
    engine.faults.set({ name: 'offline' });
    expect(await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=Snap`)).toBe('reset');
  });

  it('latencyMs delays requests', async () => {
    const { app, engine } = await served();
    engine.faults.set({ name: 'latencyMs', ms: 120 });
    const t0 = Date.now();
    await post(app, 'Login', { User: { userName: 'cams', password: 'cams-pw' } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it('the HTTPS app is unaffected by httpEnable 0 except for Download', async () => {
    const { app, t, engine } = await served();
    const np = (await post(app, 'GetNetPort', {}, t)).reply.value.NetPort;
    await post(app, 'SetNetPort', { NetPort: { ...np, httpEnable: 0 } }, t);
    const https = createCameraApp(engine, { port: 'https' });
    expect((await post(https, 'GetDevInfo', {}, t)).reply.code).toBe(0);
    const srv = await listen(app);
    closers.push(srv.close);
    expect(await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=Snap`)).toBe('reset');
  });
});

describe('camera API: Reboot', () => {
  it('goes offline, comes back with a new serial and no sessions', async () => {
    const { app, t, srv, engine } = await served();
    const serial = (await post(app, 'GetDevInfo', {}, t)).reply.value.DevInfo.serial;
    engine.config.speed = 'fast';
    const { reply } = await post(app, 'Reboot', {}, t).catch(() => ({ reply: 'dropped' as any }));
    if (reply !== 'dropped') expect(reply).toEqual({ cmd: 'Reboot', code: 0, value: { rspCode: 200 } });
    expect(engine.counters.reboots).toBe(1);
    expect(await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=Snap`)).toBe('reset');
    await new Promise((r) => setTimeout(r, 1200));
    expect((await post(app, 'GetDevInfo', {}, t)).reply.error.rspCode).toBe(-6);
    const t2 = await login(app);
    expect((await post(app, 'GetDevInfo', {}, t2)).reply.value.DevInfo.serial).not.toBe(serial);
  });

  it('rebootDefaults fix the Reboot command\'s timing and reply', async () => {
    const { app, t, srv, engine } = await served();
    engine.rebootDefaults = { ms: 80, dropsConnection: false };
    for (let i = 0; i < 4; i++) {
      const t2 = i === 0 ? t : await login(app);
      expect((await post(app, 'Reboot', {}, t2)).reply).toEqual({ cmd: 'Reboot', code: 0, value: { rspCode: 200 } });
      await new Promise((r) => setTimeout(r, 20));
      expect(engine.offline()).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(engine.offline()).toBe(false);
    }
    engine.rebootDefaults = { ms: 50, dropsConnection: true };
    const t3 = await login(app);
    await expect(post(app, 'Reboot', {}, t3)).rejects.toThrow();
    void srv;
  });

  it('reboot action parameters: timing and a dropped reply', async () => {
    const { t, srv, engine } = await served();
    const p = engine.reboot({ ms: 100, dropsConnection: true });
    expect(await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=Snap&token=${t}`)).toBe('reset');
    await p;
    expect(await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=Snap&token=${t}`)).toMatchObject({ status: 200 });
  });
});
