import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createCamSim, configFromOptions, DEMO_CLIPS, type CamSim } from '../src/index';
import { post, login } from './helpers';
import { BcClient, downloadXml } from './baichuan/client';
import { fstatSync, readdirSync, statSync } from 'fs';
import net from 'net';

const sims: CamSim[] = [];
afterEach(async () => {
  while (sims.length) await sims.pop()!.close();
});
const make = async (o: Partial<Parameters<typeof createCamSim>[0]> = {}) => {
  const sim = await createCamSim({ users: [{ name: 'u', level: 'admin', password: 'p' }], ...o });
  sims.push(sim);
  return sim;
};

describe('createCamSim', () => {
  it('works in process through supertest', async () => {
    const sim = await make({ name: 'Den', firmVer: 'v3.2.0.6011_mock' });
    const t = await login(sim.cameraApp, 'u', 'p');
    const dev = (await post(sim.cameraApp, 'GetDevInfo', {}, t)).reply.value.DevInfo;
    expect(dev).toMatchObject({ name: 'Den', firmVer: 'v3.2.0.6011_mock' });
  });

  it('exposes the engine: running settings and faults', async () => {
    const sim = await make();
    sim.engine.settings.running.Rec.enable = 0;
    sim.engine.faults.set({ name: 'settings.fail', cmds: ['SetIsp'] });
    const t = await login(sim.cameraApp, 'u', 'p');
    expect((await post(sim.cameraApp, 'GetRecV20', {}, t)).reply.value.Rec.enable).toBe(0);
    expect((await post(sim.cameraApp, 'SetIsp', { Isp: {} }, t)).reply.error.rspCode).toBe(-67);
  });

  it('seeds demo clips or a given list', async () => {
    expect((await make({ seedClips: 'demo' })).engine.sd.all()).toHaveLength(DEMO_CLIPS.length);
    expect((await make({ seedClips: [{ daysAgo: 0, start: '081510', end: '081535', triggers: ['person'] }] })).engine.sd.all()).toHaveLength(1);
  });

  it('takes faults at creation', async () => {
    const sim = await make({ faults: [{ name: 'downloads.refuse' }] });
    expect(sim.engine.faults.list()).toEqual([{ name: 'downloads.refuse' }]);
  });

  it('listens on real ports and releases them on close', async () => {
    const sim = await make({ controlToken: 'tok' });
    const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 }, '127.0.0.1');
    expect(ports.http).toBeGreaterThan(0);
    expect(ports.onvif).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${ports.control}/sim/api/state`, { headers: { Authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${ports.http}/cgi-bin/api.cgi?cmd=Snap`)).status).toBe(200);
    await sim.close();
    sims.pop();
    await expect(fetch(`http://127.0.0.1:${ports.http}/cgi-bin/api.cgi?cmd=Snap`)).rejects.toThrow();
  });

  it('control app works in process', async () => {
    const sim = await make({ controlToken: 'tok' });
    expect((await request(sim.controlApp).get('/sim/api/state').set('Authorization', 'Bearer tok')).body.name).toBe('Cam');
  });

  it('in process: a free Baichuan port by default, and shorter idle times on request', () => {
    const c = configFromOptions({ users: [] });
    expect(c.ports.baichuan).toBe(0);
    expect(c.baichuan).toEqual({ idleMs: 32_000, firstMessageMs: 12_500 });
    expect(configFromOptions({ users: [], baichuan: { idleMs: 500 } }).baichuan).toEqual({ idleMs: 500, firstMessageMs: 12_500 });
  });
});

describe('control port TLS', () => {
  it("'on' serves the camera's certificate and follows imports", async () => {
    const tls = await import('tls');
    const { generate } = await import('selfsigned');
    const sim = await make({ controlToken: 'tok', controlTls: 'on' });
    const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 }, '127.0.0.1');
    const cn = () => new Promise<string>((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: ports.control, rejectUnauthorized: false }, () => {
        resolve(String(s.getPeerCertificate().subject?.CN));
        s.end();
      });
      s.on('error', reject);
    });
    expect(await cn()).toBe('CERTIFICATE');
    const p = await generate([{ name: 'commonName', value: 'cam2.skylar.technology' }], { keySize: 2048 });
    expect(sim.engine.importCertificate(p.cert, p.private)).toBeNull();
    expect(await cn()).toBe('cam2.skylar.technology');
  });

  it("'auto' stays plain HTTP without a configured certificate", async () => {
    const sim = await make({ controlToken: 'tok' });
    const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 }, '127.0.0.1');
    expect((await fetch(`http://127.0.0.1:${ports.control}/healthz`)).status).toBe(200);
  });

  it('wires the SD pipeline into createCamSim: switched on, it reaches running', async () => {
    const sim = await createCamSim({ users: [{ name: 'u', level: 'admin', password: 'p' }] });
    await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 }, '127.0.0.1');
    try {
      sim.engine.pipelineOn(1);
      for (let i = 0; i < 150 && !(sim.engine.pipelineState() as { running?: boolean }).running; i++) await new Promise((r) => setTimeout(r, 100));
      expect(sim.engine.pipelineState(), JSON.stringify(sim.engine.pipelineState())).toMatchObject({ on: true, running: true });
    } finally {
      await sim.close();
    }
  }, 60_000);
});

// A port nobody listens on now (bound and released), and one held by us.
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const canBind = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

describe('createCamSim: a listener that fails to bind', () => {
  // Issue #65: a failed listen() left the listeners opened before it running.
  const held = async (what: 'baichuan' | 'https' | 'onvif') => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const blocked = (blocker.address() as net.AddressInfo).port;
    const ports = { http: await freePort(), https: await freePort(), control: await freePort(), onvif: await freePort(), rtsp: await freePort(), baichuan: await freePort() };
    const named = { ...ports, [what]: blocked };
    const sim = await make();
    await expect(sim.listen(named, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
    await new Promise<void>((r) => blocker.close(() => r()));
    return ports;
  };

  it('a Baichuan port in use leaves no earlier listener open', async () => {
    const ports = await held('baichuan');
    for (const p of [ports.http, ports.https, ports.control, ports.onvif, ports.rtsp]) expect(await canBind(p), `port ${p} is still open`).toBe(true);
  });

  it('an ONVIF port in use, or the camera\'s HTTPS port, leaves no earlier listener open', async () => {
    const o = await held('onvif');
    for (const p of [o.http, o.https, o.control]) expect(await canBind(p), `port ${p} is still open (onvif blocked)`).toBe(true);
    const h = await held('https');
    expect(await canBind(h.http), 'the HTTP port is still open (https blocked)').toBe(true);
  });
});

describe('createCamSim: Baichuan', () => {
  const ALL0 = { http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 };

  // Review Focus 1.
  it('opens a free Baichuan port unless one is named, so simulators side by side never collide', async () => {
    const a = await make();
    const b = await make();
    const [pa, pb] = await Promise.all([a.listen(ALL0, '127.0.0.1'), b.listen(ALL0, '127.0.0.1')]);
    expect(pa.baichuan).toBeGreaterThan(0);
    expect(pb.baichuan).toBeGreaterThan(0);
    expect(pb.baichuan).not.toBe(pa.baichuan);
    const c = await BcClient.connect(pa.baichuan!);
    expect((await c.login('u', 'p')).header.status).toBe(200);
    c.close();
  });

  // Review Focus 2.
  it('close() ends open Baichuan connections and a running transfer at once', async () => {
    const sim = await createCamSim({ users: [{ name: 'u', level: 'admin', password: 'p' }], seedClips: 'demo' });
    const ports = await sim.listen(ALL0, '127.0.0.1');
    sim.engine.faults.set({ name: 'baichuan.delayMs', ms: 50 });
    const c = await BcClient.connect(ports.baichuan!);
    await c.login('u', 'p');
    const id = c.send(8, downloadXml(sim.engine.sd.all()[0].files.main.name));
    await c.waitIndex((f) => f.header.msgId === id);
    const t0 = Date.now();
    await sim.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(['eof', 'reset']).toContain(await c.ended);
  });

  // Final review 3: the baichuan.delayMs wait is cancellable and unref'd.
  it('close() during a 20 s baichuan.delayMs wait returns promptly and leaves no open file and no timer', async () => {
    const sim = await createCamSim({ users: [{ name: 'u', level: 'admin', password: 'p' }], seedClips: 'demo' });
    const ports = await sim.listen(ALL0, '127.0.0.1');
    const rec = sim.engine.sd.all()[0];
    const clip = statSync(sim.engine.mediaFor(rec).clipPath('main'));
    // File descriptors of this process open on the clip (/dev/fd on macOS and Linux).
    const openOnClip = () => readdirSync('/dev/fd').filter((fd) => {
      try {
        const st = fstatSync(Number(fd));
        return st.ino === clip.ino && st.dev === clip.dev;
      } catch {
        return false;
      }
    }).length;
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    // The previous test's transfer on the same demo clip may still be closing its file.
    await expect.poll(openOnClip).toBe(0);
    sim.engine.faults.set({ name: 'baichuan.delayMs', ms: 20_000 });
    const c = await BcClient.connect(ports.baichuan!);
    await c.login('u', 'p');
    const before = timers();
    const id = c.send(8, downloadXml(rec.files.main.name));
    await c.waitIndex((f) => f.header.msgId === id); // the record; the first chunk waits 20 s
    await new Promise((r) => setTimeout(r, 50));
    expect(openOnClip()).toBe(1);
    const t0 = Date.now();
    await sim.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(['eof', 'reset']).toContain(await c.ended);
    await new Promise((r) => setTimeout(r, 100));
    expect(openOnClip()).toBe(0);
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it('takes shorter Baichuan idle times for tests (CamSimOptions.baichuan)', async () => {
    const sim = await make({ baichuan: { firstMessageMs: 200, idleMs: 300 } });
    const ports = await sim.listen(ALL0, '127.0.0.1');
    const t0 = Date.now();
    const c = await BcClient.connect(ports.baichuan!);
    expect(await c.ended).toBe('eof');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
