import { describe, it, expect } from 'vitest';
import { makeCamera, post, login } from '../helpers';
import { DEFAULT_NTP } from '../../src/profile/rlc1224a';

describe('camera API: settings', () => {
  it('Get/Set with whole objects, counting Set calls', async () => {
    const { app, engine } = await makeCamera();
    const t = await login(app);
    const isp = (await post(app, 'GetIsp', { channel: 0 }, t)).reply.value.Isp;
    const set = await post(app, 'SetIsp', { Isp: { ...isp, dayNight: 'Color' } }, t);
    expect(set.reply).toEqual({ cmd: 'SetIsp', code: 0, value: { rspCode: 200 } });
    expect((await post(app, 'GetIsp', { channel: 0 }, t)).reply.value.Isp.dayNight).toBe('Color');
    expect(engine.counters.setCalls).toEqual(['SetIsp']);
  });

  it('a partial Set resets omitted keys after a reboot', async () => {
    const { app, engine } = await makeCamera();
    const t = await login(app);
    await post(app, 'SetIsp', { Isp: { channel: 0, dayNight: 'Color' } }, t);
    expect((await post(app, 'GetIsp', {}, t)).reply.value.Isp.rotation).toBe(0);
    await engine.reboot({ ms: 1, dropsConnection: false });
    const t2 = await login(app);
    expect((await post(app, 'GetIsp', {}, t2)).reply.value.Isp.rotation).toBe(1);
  });

  it('strictPartial shows the reset at once', async () => {
    const { app, engine } = await makeCamera();
    engine.faults.set({ name: 'settings.strictPartial' });
    const t = await login(app);
    await post(app, 'SetIsp', { Isp: { channel: 0, dayNight: 'Color' } }, t);
    expect((await post(app, 'GetIsp', {}, t)).reply.value.Isp.rotation).toBe(1);
  });

  it('rejects invalid values with the firmware codes', async () => {
    const { app } = await makeCamera();
    const t = await login(app);
    expect((await post(app, 'SetMdAlarm', { MdAlarm: { channel: 0, newSens: { sensDef: 99 } } }, t)).reply).toMatchObject({ code: 1, error: { rspCode: -56 } });
    expect((await post(app, 'SetIsp', { Isp: { dayNight: 'Purple' } }, t)).reply.error.rspCode).toBe(-67);
    expect((await post(app, 'SetFtpV20', { Ftp: { server: '' } }, t)).reply.error.rspCode).toBe(-4);
  });

  it('WhiteLed.state is the manual light switch (measured 2026-09-29)', async () => {
    const { app } = await makeCamera();
    const t = await login(app);
    const before = (await post(app, 'GetWhiteLed', { channel: 0 }, t)).reply.value.WhiteLed;
    expect(before.state).toBe(0);
    expect((await post(app, 'SetWhiteLed', { WhiteLed: { ...before, state: 1 } }, t)).reply.code).toBe(0);
    // Reported about 1 s late, like the camera (measured 2026-09-30).
    expect((await post(app, 'GetWhiteLed', { channel: 0 }, t)).reply.value.WhiteLed.state).toBe(0);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await post(app, 'GetWhiteLed', { channel: 0 }, t)).reply.value.WhiteLed).toEqual({ ...before, state: 1 });
    expect((await post(app, 'SetWhiteLed', { WhiteLed: { ...before, state: 2 } }, t)).reply.error.rspCode).toBe(-56);
    expect((await post(app, 'GetWhiteLed', { channel: 0 }, t)).reply.value.WhiteLed.state).toBe(1);
  });

  it('settings.fail and settings.ignore faults', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_FAULTS: '[{"name":"settings.fail","cmds":["SetWhiteLed"]},{"name":"settings.ignore","cmds":["SetIrLights"]}]' });
    const t = await login(app);
    const wl = (await post(app, 'GetWhiteLed', {}, t)).reply.value.WhiteLed;
    expect((await post(app, 'SetWhiteLed', { WhiteLed: { ...wl, bright: 10 } }, t)).reply.error.rspCode).toBe(-67);
    expect((await post(app, 'SetIrLights', { IrLights: { state: 'Off' } }, t)).reply.code).toBe(0);
    expect((await post(app, 'GetIrLights', {}, t)).reply.value.IrLights.state).toBe('Auto');
    expect(engine.counters.setCalls).toEqual(['SetWhiteLed', 'SetIrLights']);
  });

  it('GetIrLights carries initial and range like the firmware', async () => {
    const { app } = await makeCamera();
    const t = await login(app);
    const { reply } = await post(app, 'GetIrLights', { channel: 0 }, t);
    expect(reply).toEqual({
      cmd: 'GetIrLights', code: 0,
      initial: { IrLights: { state: 'Auto' } }, range: { IrLights: { state: ['Auto', 'Off'] } },
      value: { IrLights: { state: 'Auto' } },
    });
  });

  it('GetAiAlarm answers per ai_type', async () => {
    const { app } = await makeCamera();
    const t = await login(app);
    expect((await post(app, 'GetAiAlarm', { channel: 0, ai_type: 'dog_cat' }, t)).reply.value.AiAlarm.ai_type).toBe('dog_cat');
  });

  it('exposes the running settings for in-process tests', async () => {
    const { app, engine } = await makeCamera();
    engine.settings.running.Rec.enable = 0;
    const t = await login(app);
    expect((await post(app, 'GetRecV20', { channel: 0 }, t)).reply.value.Rec.enable).toBe(0);
  });

  it('reports detection state', async () => {
    const { app, engine } = await makeCamera();
    const t = await login(app);
    expect((await post(app, 'GetMdState', { channel: 0 }, t)).reply.value).toEqual({ state: 0 });
    engine.events.trigger('vehicle', 30);
    expect((await post(app, 'GetMdState', { channel: 0 }, t)).reply.value).toEqual({ state: 1 });
    expect((await post(app, 'GetAiState', { channel: 0 }, t)).reply.value.vehicle.alarm_state).toBe(1);
    engine.stop();
  });

  it('GetFtpV20 masks the user like the real camera (ca**ra); Set and TestFtp keep the full name', async () => {
    const { app, engine } = await makeCamera();
    const t = await login(app);
    const ftp = (await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp;
    await post(app, 'SetFtpV20', { Ftp: { ...ftp, server: '127.0.0.1', userName: 'camera' } }, t);
    expect(engine.settings.get('Ftp').userName).toBe('camera');
    expect((await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp.userName).toBe('ca**ra');
    await post(app, 'SetFtpV20', { Ftp: { ...ftp, server: '127.0.0.1', userName: 'cam' } }, t);
    expect((await post(app, 'GetFtpV20', { channel: 0 }, t)).reply.value.Ftp.userName).toBe('cam');
  });

  // Not measured yet (cam-proxy P4 measures GetNtp on the multi-camera host):
  // the Reolink API document's shape until then.
  it('GetNtp answers the Ntp object; SetNtp stores a whole object', async () => {
    const { app, engine } = await makeCamera();
    const t = await login(app);
    const before = (await post(app, 'GetNtp', {}, t)).reply;
    expect(before).toEqual({ cmd: 'GetNtp', code: 0, value: { Ntp: DEFAULT_NTP } });
    expect(DEFAULT_NTP).toEqual({ enable: 1, interval: 1440, port: 123, server: 'pool.ntp.org' });
    const set = await post(app, 'SetNtp', { Ntp: { ...DEFAULT_NTP, server: '192.168.60.1' } }, t);
    expect(set.reply).toEqual({ cmd: 'SetNtp', code: 0, value: { rspCode: 200 } });
    expect((await post(app, 'GetNtp', {}, t)).reply.value.Ntp).toEqual({ ...DEFAULT_NTP, server: '192.168.60.1' });
    expect(engine.counters.setCalls).toEqual(['SetNtp']);
    // Survives a reboot (a whole-object Set).
    await engine.reboot({ ms: 1, dropsConnection: false });
    const t2 = await login(app);
    expect((await post(app, 'GetNtp', {}, t2)).reply.value.Ntp.server).toBe('192.168.60.1');
  });
});
