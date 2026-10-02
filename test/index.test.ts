import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createCamSim, configFromOptions, DEMO_CLIPS, type CamSim } from '../src/index';
import { post, login } from './helpers';

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
