import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { makeEngine, post, login, listen } from './helpers';
import { createControlApp } from '../src/control-api/app';
import { createCameraApp } from '../src/camera-api/app';

const TOKEN = 'control-token-for-tests';
const auth = { Authorization: `Bearer ${TOKEN}` };

async function setup(env: Record<string, string> = {}) {
  const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: TOKEN, ...env });
  return { engine, ctl: createControlApp(engine), cam: createCameraApp(engine, { port: 'http' }) };
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('control API: auth', () => {
  it('requires the bearer token', async () => {
    const { ctl } = await setup();
    expect((await request(ctl).get('/sim/api/state')).status).toBe(401);
    expect((await request(ctl).get('/sim/api/state').set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(ctl).get('/sim/api/state').set('Authorization', `Basic ${TOKEN}`)).status).toBe(401);
    expect((await request(ctl).get('/sim/api/state').set(auth)).status).toBe(200);
  });

  it('refuses a token in the URL', async () => {
    const { ctl } = await setup();
    expect((await request(ctl).get(`/sim/api/state?token=${TOKEN}`).set(auth)).body).toEqual({ error: 'token_in_url' });
    expect((await request(ctl).get(`/sim/api/state?access_token=${TOKEN}`)).status).toBe(400);
  });

  it('is disabled without a configured token; /healthz still works', async () => {
    const engine = await makeEngine();
    const ctl = createControlApp(engine);
    expect((await request(ctl).get('/sim/api/state').set(auth)).status).toBe(404);
    expect((await request(ctl).get('/healthz')).status).toBe(200);
  });
});

describe('control API: state, events, recordings', () => {
  it('reports state and counters', async () => {
    const { ctl, cam } = await setup({ CAMSIM_NAME: 'Shed' });
    await login(cam);
    const s = (await request(ctl).get('/sim/api/state').set(auth)).body;
    expect(s).toMatchObject({ name: 'Shed', model: 'RLC-1224A', offline: false, rebooting: false, faults: [], counters: { logins: 1, activeSessions: 1 } });
    expect(s.serial).toMatch(/^SIM/);
    expect(s.sd).toMatchObject({ capacityMb: 4096, recordings: 0 });
    expect(s.settings.Isp.dayNight).toBe('Auto');
    expect(s.tz).toBe('America/Chicago');
  });

  it('triggers an event that Search then finds', async () => {
    const { ctl, cam, engine } = await setup();
    closers.push(() => engine.stop());
    const r = await request(ctl).post('/sim/api/events').set(auth).send({ type: 'person', durationS: 5 });
    expect(r.status).toBe(201);
    expect(r.body.recording.files.sub.name).toMatch(/_000000_0_5514C080000000_/);
    const t = await login(cam);
    const now = new Date();
    const d = { year: now.getFullYear(), mon: now.getMonth() + 1, day: now.getDate() };
    const found = (await post(cam, 'Search', { Search: { channel: 0, onlyStatus: 0, streamType: 'sub', StartTime: d, EndTime: d } }, t)).reply.value.SearchResult.File;
    expect(found).toHaveLength(1);
    expect((await request(ctl).get('/sim/api/events').set(auth)).body[0]).toMatchObject({ type: 'person', durationS: 5 });
  });

  it('validates event input', async () => {
    const { ctl } = await setup();
    expect((await request(ctl).post('/sim/api/events').set(auth).send({ type: 'ghost', durationS: 5 })).status).toBe(400);
    expect((await request(ctl).post('/sim/api/events').set(auth).send({ type: 'motion', durationS: 0 })).status).toBe(400);
    expect((await request(ctl).post('/sim/api/events').set(auth).send({ type: 'motion', durationS: 3601 })).status).toBe(400);
  });

  it('seeds and clears recordings', async () => {
    const { ctl, engine } = await setup();
    expect((await request(ctl).post('/sim/api/recordings/seed').set(auth).send({ clips: 'demo' })).body).toEqual({ added: 6 });
    expect((await request(ctl).post('/sim/api/recordings/seed').set(auth).send({ clips: [{ daysAgo: 2, start: '010203', end: '010233', triggers: ['pet'] }] })).body).toEqual({ added: 1 });
    expect((await request(ctl).post('/sim/api/recordings/seed').set(auth).send({ clips: [{ daysAgo: 2, start: '99', end: 'x', triggers: ['pet'] }] })).status).toBe(400);
    expect(engine.sd.all()).toHaveLength(7);
    expect((await request(ctl).delete('/sim/api/recordings').set(auth)).status).toBe(204);
    expect(engine.sd.all()).toHaveLength(0);
  });

});

describe('control API: faults, actions, reset', () => {
  it('sets, lists and clears faults', async () => {
    const { ctl, cam } = await setup();
    expect((await request(ctl).put('/sim/api/faults/settings.fail').set(auth).send({ cmds: ['SetIsp'] })).status).toBe(200);
    expect((await request(ctl).get('/sim/api/faults').set(auth)).body).toEqual([{ name: 'settings.fail', cmds: ['SetIsp'], rspCode: -67 }]);
    const t = await login(cam);
    expect((await post(cam, 'SetIsp', { Isp: { dayNight: 'Color' } }, t)).reply.error.rspCode).toBe(-67);
    expect((await request(ctl).delete('/sim/api/faults/settings.fail').set(auth)).status).toBe(204);
    expect((await request(ctl).put('/sim/api/faults/bogus').set(auth).send({})).status).toBe(400);
    expect((await request(ctl).put('/sim/api/faults/latencyMs').set(auth).send({})).body.error).toBe('invalid');
    await request(ctl).put('/sim/api/faults/offline').set(auth).send({});
    expect((await request(ctl).delete('/sim/api/faults').set(auth)).status).toBe(204);
    expect((await request(ctl).get('/sim/api/faults').set(auth)).body).toEqual([]);
  });

  it('runs one-shot actions', async () => {
    const { ctl, cam, engine } = await setup();
    const t = await login(cam);
    expect((await request(ctl).post('/sim/api/actions/tokens.revoke').set(auth)).status).toBe(204);
    expect((await post(cam, 'GetDevInfo', {}, t)).reply.error.rspCode).toBe(-6);
    expect((await request(ctl).post('/sim/api/actions/reboot').set(auth).send({ ms: 50 })).status).toBe(202);
    expect(engine.offline()).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(engine.offline()).toBe(false);
    expect((await request(ctl).post('/sim/api/actions/nope').set(auth)).status).toBe(400);
  });

  it('power-off takes the camera down until power-on boots it', async () => {
    const { ctl, cam, engine } = await setup();
    closers.push(() => engine.stop());
    const t = await login(cam);
    engine.events.trigger('motion', 60);
    expect((await request(ctl).post('/sim/api/actions/power-off').set(auth)).status).toBe(204);
    expect(engine.offline()).toBe(true);
    expect(engine.sd.all()[0].end).not.toBeNull(); // the recording was closed
    let s = (await request(ctl).get('/sim/api/state').set(auth)).body;
    expect(s.power).toBe('off');
    expect((await request(ctl).post('/sim/api/events').set(auth).send({ type: 'motion', durationS: 5 })).body).toEqual({ error: 'powered_off' });
    expect((await request(ctl).post('/sim/api/actions/power-off').set(auth)).status).toBe(409);
    expect((await request(ctl).post('/sim/api/actions/reboot').set(auth)).status).toBe(409);
    const serial = s.serial;

    expect((await request(ctl).post('/sim/api/actions/power-on').set(auth).send({ ms: 60 })).status).toBe(202);
    expect((await request(ctl).get('/sim/api/state').set(auth)).body.power).toBe('booting');
    expect(engine.offline()).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    s = (await request(ctl).get('/sim/api/state').set(auth)).body;
    expect(s.power).toBe('on');
    expect(s.serial).not.toBe(serial);
    expect((await post(cam, 'GetDevInfo', {}, t)).reply.error.rspCode).toBe(-6);
    expect((await request(ctl).post('/sim/api/actions/power-on').set(auth)).status).toBe(409);
  });

  it('power-off applies saved settings at the next power-on', async () => {
    const { ctl, cam, engine } = await setup();
    const t = await login(cam);
    await post(cam, 'SetIsp', { Isp: { channel: 0, dayNight: 'Color' } }, t); // partial write
    expect(engine.settings.running.Isp.rotation).toBe(0);
    await request(ctl).post('/sim/api/actions/power-off').set(auth);
    await request(ctl).post('/sim/api/actions/power-on').set(auth).send({ ms: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.settings.running.Isp.rotation).toBe(1);
  });

  it('resets to a known state', async () => {
    const { ctl, cam, engine } = await setup();
    await login(cam);
    engine.faults.set({ name: 'snap.fail' });
    engine.sd.seed([{ daysAgo: 0, start: '010000', end: '010010', triggers: ['motion'] }]);
    engine.settings.running.Isp.dayNight = 'Color';
    expect((await request(ctl).post('/sim/api/reset').set(auth).send({})).status).toBe(204);
    const s = (await request(ctl).get('/sim/api/state').set(auth)).body;
    expect(s.faults).toEqual([]);
    expect(s.sd.recordings).toBe(0);
    expect(s.counters.logins).toBe(0);
    expect(s.settings.Isp.dayNight).toBe('Auto');
  });

  it('resets only what is asked', async () => {
    const { ctl, engine } = await setup();
    engine.faults.set({ name: 'snap.fail' });
    await request(ctl).post('/sim/api/reset').set(auth).send({ counters: true });
    expect(engine.faults.list()).toHaveLength(1);
  });
});

describe('control API: request log and SSE', () => {
  it('lists recent camera requests without query strings', async () => {
    const { ctl, cam } = await setup();
    const t = await login(cam);
    await request(cam).get(`/cgi-bin/api.cgi?cmd=Snap&token=${t}`);
    const reqs = (await request(ctl).get('/sim/api/requests?limit=5').set(auth)).body;
    expect(reqs[0]).toMatchObject({ method: 'GET', path: '/cgi-bin/api.cgi', cmd: 'Snap', status: 200, port: 'http' });
    expect(JSON.stringify(reqs)).not.toContain(t);
  });

  it('streams events over SSE', async () => {
    const { ctl, engine } = await setup();
    closers.push(() => engine.stop());
    const srv = await listen(ctl);
    closers.push(srv.close);
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/sim/api/stream`, { headers: auth, signal: ac.signal });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    engine.events.trigger('pet', 2);
    let text = '';
    while (!/event: event\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    expect(text).toMatch(/id: \d+\nevent: event\ndata: \{.*"type":"pet"/);
  });
});
