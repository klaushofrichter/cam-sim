import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import request from 'supertest';
import { makeEngine, listen, post, login } from './helpers';
import { createControlApp } from '../src/control-api/app';
import { createCameraApp } from '../src/camera-api/app';
import { readFlv } from '../src/media/flv';

const TOKEN = 'ui-routes-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(env: Record<string, string> = {}) {
  const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: TOKEN, ...env });
  closers.push(() => engine.stop());
  return { engine, ctl: createControlApp(engine), cam: createCameraApp(engine, { port: 'http' }) };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

describe('control API: media for the UI', () => {
  it('serves a snapshot', async () => {
    const { ctl } = await setup();
    const res = await request(ctl).get('/sim/api/media/snapshot').set(auth).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('streams live FLV without touching the camera counters', async () => {
    const { ctl, engine } = await setup();
    const srv = await listen(ctl);
    closers.push(srv.close);
    for (const [stream, codec] of [['sub', 7], ['main', 12]] as const) {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const req = http.get(`${srv.url}/sim/api/media/live/${stream}`, { headers: auth }, (res) => {
          expect(res.headers['content-type']).toBe('video/x-flv');
          res.on('data', (c: Buffer) => {
            chunks.push(c);
            if (Buffer.concat(chunks).length > 4096) {
              req.destroy();
              resolve(Buffer.concat(chunks));
            }
          });
        });
        req.on('error', (e) => (chunks.length ? resolve(Buffer.concat(chunks)) : reject(e)));
      });
      expect(body.subarray(0, 3).toString()).toBe('FLV');
      expect(readFlv(body).tags.find((t) => t.type === 9)?.codecId).toBe(codec);
    }
    expect(engine.counters.streamsOpened).toBe(0);
    expect((await request(ctl).get('/sim/api/media/live/other').set(auth)).status).toBe(404);
  });

  it('drops a UI viewer that stops reading', async () => {
    const { ctl, engine } = await setup();
    engine.limits.flvBufferBytes = 64 * 1024;
    const srv = await listen(ctl);
    closers.push(srv.close);
    const sock = net.connect(srv.port, '127.0.0.1');
    sock.write(`GET /sim/api/media/live/main HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    sock.pause();
    await expect.poll(() => engine.activeFlv.size, { timeout: 3000 }).toBe(1);
    await expect.poll(() => engine.activeFlv.size, { timeout: 10_000 }).toBe(0);
    sock.destroy();
  }, 20_000);
});

describe('control API: recordings for the UI', () => {
  it('lists a day, the month table, and serves the files', async () => {
    const { ctl, engine } = await setup();
    engine.events.trigger('person', 2);
    const list = (await request(ctl).get(`/sim/api/recordings?date=${today()}`).set(auth)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ date: today(), triggers: expect.arrayContaining(['person', 'motion']) });
    const [y, m] = today().split('-').map(Number);
    const days = (await request(ctl).get(`/sim/api/recordings/days?year=${y}&mon=${m}`).set(auth)).body;
    expect(days.table[Number(today().slice(8)) - 1]).toBe('1');
    const file = await request(ctl).get(`/sim/api/recordings/${list[0].id}/sub?download=1`).set(auth).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('video/mp4');
    expect(Number(file.headers['content-length'])).toBe(file.body.length);
    expect(file.headers['content-disposition']).toMatch(/attachment; filename="RecS0A_/);
    expect(file.body.subarray(4, 12).toString()).toBe('ftypmp42');
    expect(engine.counters.downloads).toBe(0);
  });

  it('validates its inputs', async () => {
    const { ctl } = await setup();
    expect((await request(ctl).get('/sim/api/recordings?date=yesterday').set(auth)).status).toBe(400);
    expect((await request(ctl).get('/sim/api/recordings/days?year=x&mon=1').set(auth)).status).toBe(400);
    expect((await request(ctl).get('/sim/api/recordings/nope/sub').set(auth)).status).toBe(404);
    expect((await request(ctl).get('/sim/api/recordings/x/other').set(auth)).status).toBe(404);
  });
});

describe('control API: settings and users for the UI', () => {
  it('reads everything the settings page shows', async () => {
    const { ctl } = await setup({ CAMSIM_NAME: 'cam2' });
    const s = (await request(ctl).get('/sim/api/settings').set(auth)).body;
    expect(s.devInfo).toMatchObject({ model: 'RLC-1224A', name: 'cam2' });
    expect(s.hddInfo[0]).toHaveProperty('capacity');
    expect(s.enc.mainStream.vType).toBe('h265');
    expect(s.certificate).toEqual({ source: 'factory', enable: 0 });
    expect(s.settings.Isp.dayNight).toBe('Auto');
  });

  it('writes whole objects with the camera\'s validation', async () => {
    const { ctl, cam, engine } = await setup();
    const isp = (await request(ctl).get('/sim/api/settings').set(auth)).body.settings.Isp;
    expect((await request(ctl).put('/sim/api/settings/Isp').set(auth).send({ ...isp, dayNight: 'Color' })).status).toBe(200);
    const t = await login(cam);
    expect((await post(cam, 'GetIsp', {}, t)).reply.value.Isp).toMatchObject({ dayNight: 'Color', rotation: 0 });
    expect(engine.settings.saved.Isp.rotation).toBe(0); // a whole-object write
    const md = (await request(ctl).get('/sim/api/settings').set(auth)).body.settings.MdAlarm;
    const bad = await request(ctl).put('/sim/api/settings/MdAlarm').set(auth).send({ ...md, newSens: { ...md.newSens, sensDef: 99 } });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid', rspCode: -56 });
    expect(engine.settings.running.MdAlarm.newSens.sensDef).toBe(10);
    const ai = (await request(ctl).get('/sim/api/settings').set(auth)).body.settings.AiAlarm.vehicle;
    expect((await request(ctl).put('/sim/api/settings/AiAlarm/vehicle').set(auth).send({ ...ai, sensitivity: 30 })).status).toBe(200);
    expect(engine.settings.running.AiAlarm.vehicle.sensitivity).toBe(30);
    expect((await request(ctl).put('/sim/api/settings/Bogus').set(auth).send({})).status).toBe(404);
    expect((await request(ctl).put('/sim/api/settings/AiAlarm/cat').set(auth).send({})).status).toBe(404);
  });

  it('lists users without passwords', async () => {
    const { ctl } = await setup();
    const users = (await request(ctl).get('/sim/api/users').set(auth)).body;
    expect(users).toEqual([{ level: 'admin', userName: 'admin' }, { level: 'admin', userName: 'cams' }]);
  });
});
