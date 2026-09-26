import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeCamera, post, login } from '../helpers';

describe('camera API: sessions and device', () => {
  it('logs in and answers text/html like the firmware', async () => {
    const { app, engine } = await makeCamera();
    const { res, reply } = await post(app, 'Login', { User: { Version: '0', userName: 'cams', password: 'cams-pw' } });
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(reply).toMatchObject({ cmd: 'Login', code: 0, value: { Token: { leaseTime: 3600 } } });
    expect(reply.value.Token.name).toMatch(/^[0-9a-f]{16}$/);
    expect(engine.counters.logins).toBe(1);
  });

  it('rejects a wrong password with -7', async () => {
    const { app, engine } = await makeCamera();
    const { reply } = await post(app, 'Login', { User: { userName: 'cams', password: 'nope' } });
    expect(reply).toEqual({ cmd: 'Login', code: 1, error: { detail: 'login failed', rspCode: -7 } });
    expect(engine.counters.loginAttempts).toBe(1);
    expect(engine.counters.logins).toBe(0);
  });

  it('answers -6 without a valid token', async () => {
    const { app } = await makeCamera();
    for (const token of [undefined, 'deadbeefdeadbeef']) {
      const { reply } = await post(app, 'GetDevInfo', {}, token);
      expect(reply).toEqual({ cmd: 'GetDevInfo', code: 1, error: { detail: 'please login first', rspCode: -6 } });
    }
  });

  it('answers unknown commands like the firmware', async () => {
    const { app } = await makeCamera();
    const t = await login(app);
    for (const cmd of ['FooBarCmd', 'GetFtp', 'TestFtpV20', 'GetEmail']) {
      const { reply } = await post(app, cmd, {}, t);
      expect(reply).toEqual({ cmd: 'Unknown', code: 1, error: { detail: 'not support', rspCode: -9 } });
    }
  });

  it('reports device info, time, encoders, ports, abilities and storage', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Porch' });
    const t = await login(app);
    const dev = (await post(app, 'GetDevInfo', {}, t)).reply.value.DevInfo;
    expect(dev).toMatchObject({ model: 'RLC-1224A', firmVer: 'v3.2.0.6011_2607012059', name: 'Porch' });
    expect(dev.serial).toMatch(/^SIM[0-9A-F]{12}$/);
    expect(engine.counters.devInfoCalls).toBe(1);
    expect((await post(app, 'GetTime', {}, t)).reply.value.Time.timeZone).toBe(21600);
    expect((await post(app, 'GetEnc', { channel: 0 }, t)).reply.value.Enc.mainStream.vType).toBe('h265');
    expect((await post(app, 'GetNetPort', {}, t)).reply.value.NetPort.httpsPort).toBe(443);
    expect((await post(app, 'GetAbility', { User: { userName: 'cams' } }, t)).reply.value.Ability).toHaveProperty('httpFlv');
    expect((await post(app, 'GetHddInfo', {}, t)).reply.value.HddInfo[0]).toMatchObject({ capacity: 4096, mount: 1 });
  });

  it('honours CAMSIM_FIRMWARE', async () => {
    const { app } = await makeCamera({ CAMSIM_FIRMWARE: 'v3.2.0.6011_mock' });
    const t = await login(app);
    expect((await post(app, 'GetDevInfo', {}, t)).reply.value.DevInfo.firmVer).toBe('v3.2.0.6011_mock');
  });

  it('lists accumulating sessions and ends them on Logout', async () => {
    const { app } = await makeCamera();
    const a = await login(app);
    await login(app);
    await login(app, 'admin', 'admin-pw');
    const online = (await post(app, 'GetOnline', {}, a)).reply.value.User;
    expect(online.map((u: any) => u.userName)).toEqual(['cams', 'cams', 'admin']);
    expect((await post(app, 'Logout', {}, a)).reply).toMatchObject({ code: 0 });
    expect((await post(app, 'GetDevInfo', {}, a)).reply.error.rspCode).toBe(-6);
  });

  it('manages users; a password change invalidates that user\'s tokens', async () => {
    const { app } = await makeCamera();
    const admin = await login(app, 'admin', 'admin-pw');
    const cams = await login(app);
    const users = (await post(app, 'GetUser', {}, admin)).reply.value;
    expect(users).toEqual({ CurUser: { User: 'admin' }, User: [{ level: 'admin', userName: 'admin' }, { level: 'admin', userName: 'cams' }] });
    expect((await post(app, 'AddUser', { User: { userName: 'g', password: 'gp', level: 'guest' } }, admin)).reply.code).toBe(0);
    expect((await post(app, 'AddUser', { User: { userName: 'g', password: 'gp', level: 'guest' } }, admin)).reply.error.rspCode).toBe(-4);
    expect((await post(app, 'ModifyUser', { User: { userName: 'cams', password: 'new' } }, admin)).reply.code).toBe(0);
    expect((await post(app, 'GetDevInfo', {}, cams)).reply.error.rspCode).toBe(-6);
    expect(await login(app, 'cams', 'new')).toMatch(/^[0-9a-f]{16}$/);
    expect((await post(app, 'DelUser', { User: { userName: 'g' } }, admin)).reply.code).toBe(0);
  });

  it('answers a body that is not JSON with -4', async () => {
    const { app } = await makeCamera();
    const res = await request(app).post('/cgi-bin/api.cgi?cmd=Login').set('Content-Type', 'application/json').send('[{');
    expect(JSON.parse(res.text)[0].error.rspCode).toBe(-4);
  });
});
