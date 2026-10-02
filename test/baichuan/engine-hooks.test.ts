import { describe, it, expect, vi } from 'vitest';
import { makeEngine, login, post } from '../helpers';
import { createCameraApp } from '../../src/camera-api/app';

describe('engine hooks for port 9000', () => {
  it('downloads.dropActive, power-off and reboot reach the Baichuan server', async () => {
    const e = await makeEngine();
    const hooks = { dropAll: vi.fn(), dropTransfers: vi.fn() };
    e.baichuan = hooks;
    e.dropDownloads();
    expect(hooks.dropTransfers).toHaveBeenCalledTimes(1);
    expect(e.powerOff()).toBe(true);
    expect(hooks.dropAll).toHaveBeenCalledTimes(1);
    await e.powerOn(0);
    await e.reboot({ ms: 0 });
    expect(hooks.dropAll).toHaveBeenCalledTimes(2);
  });

  it('HTTP GetOnline lists a Baichuan session after the HTTP ones', async () => {
    const e = await makeEngine();
    const cam = createCameraApp(e, { port: 'http' });
    const t = await login(cam);
    e.sessions.openBaichuan({ name: 'admin', level: 'admin', password: 'admin-pw' }, '10.0.0.9');
    const users = (await post(cam, 'GetOnline', {}, t)).reply.value.User;
    expect(users.map((u: { userName: string }) => u.userName)).toEqual(['cams', 'admin']);
    expect(users[1]).toMatchObject({ ip: '10.0.0.9', level: 'admin', canbeDisconn: 0 });
  });
});
