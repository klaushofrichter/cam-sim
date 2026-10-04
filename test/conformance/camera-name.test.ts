import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { makeCamera, post, login } from '../helpers';

// The camera's name, measured on cam1 2026-10-03 (firmware v3.2.0.6011):
// GetDevName, GetDevInfo.name and the OSD text are one value; SetDevName and a
// whole-object SetOsd both change it. 1–31 characters of ASCII letters,
// digits, space and - ( ) + = [ ] { }, no leading or trailing space. Anything
// else -54, longer than 31 -56; a refused write keeps the old name.

type App = Awaited<ReturnType<typeof makeCamera>>['app'];

async function names(app: App, t: string) {
  return {
    devName: (await post(app, 'GetDevName', { channel: 0 }, t)).reply.value.DevName.name,
    devInfo: (await post(app, 'GetDevInfo', {}, t)).reply.value.DevInfo.name,
    osd: (await post(app, 'GetOsd', { channel: 0 }, t)).reply.value.Osd.osdChannel.name,
  };
}
const one = (name: string) => ({ devName: name, devInfo: name, osd: name });

async function setName(app: App, t: string, name: unknown) {
  return (await post(app, 'SetDevName', { DevName: { name } }, t)).reply;
}

describe('camera API: the camera name', () => {
  it('starts as CAMSIM_NAME in all three reads', async () => {
    const { app } = await makeCamera({ CAMSIM_NAME: 'Porch' });
    const t = await login(app);
    expect(await names(app, t)).toEqual(one('Porch'));
  });

  it('GetDevName action 1 answers the initial value and the range', async () => {
    const { app } = await makeCamera({ CAMSIM_NAME: 'Porch' });
    const t = await login(app);
    await setName(app, t, 'Backyard Left');
    const res = await request(app)
      .post(`/cgi-bin/api.cgi?cmd=GetDevName&token=${t}`)
      .set('Content-Type', 'application/json')
      .send([{ cmd: 'GetDevName', action: 1, param: { channel: 0 } }]);
    expect(JSON.parse(res.text)[0]).toEqual({
      cmd: 'GetDevName', code: 0,
      initial: { DevName: { name: 'Porch' } },
      range: { DevName: { name: { maxLen: 31, minLen: 0 } } },
      value: { DevName: { name: 'Backyard Left' } },
    });
    // action 0: the value only.
    expect((await post(app, 'GetDevName', { channel: 0 }, t)).reply).toEqual({ cmd: 'GetDevName', code: 0, value: { DevName: { name: 'Backyard Left' } } });
  });

  it('SetDevName changes all three', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const t = await login(app);
    expect(await setName(app, t, 'Backyard Left')).toEqual({ cmd: 'SetDevName', code: 0, value: { rspCode: 200 } });
    expect(await names(app, t)).toEqual(one('Backyard Left'));
    expect(engine.state().name).toBe('Backyard Left');
    expect(engine.counters.setCalls).toEqual(['SetDevName']);
  });

  it('SetDevName tells the overlay (settings event), a refused one does not', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const seen: unknown[] = [];
    engine.bus.on('settings', (d) => seen.push(d));
    const t = await login(app);
    await setName(app, t, 'Den_1');
    await setName(app, t, 'Garage');
    expect(seen).toEqual([{ cmd: 'SetDevName' }]);
  });

  it('a whole-object SetOsd with a new osdChannel.name changes all three', async () => {
    const { app } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const t = await login(app);
    const osd = (await post(app, 'GetOsd', { channel: 0 }, t)).reply.value.Osd;
    const r = await post(app, 'SetOsd', { Osd: { ...osd, osdChannel: { ...osd.osdChannel, name: 'Garage (2)' } } }, t);
    expect(r.reply.code).toBe(0);
    expect(await names(app, t)).toEqual(one('Garage (2)'));
  });

  it('a SetOsd without a name keeps the name', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Den' });
    engine.faults.set({ name: 'settings.strictPartial' });
    const t = await login(app);
    await post(app, 'SetOsd', { Osd: { channel: 0, osdTime: { enable: 0, pos: 'Top Center' } } }, t);
    await engine.reboot({ ms: 1, dropsConnection: false });
    const t2 = await login(app);
    expect(await names(app, t2)).toEqual(one('Den'));
  });

  it.each([
    'A',
    'x'.repeat(31),
    'Backyard Left',
    '0123456789',
    'a-b(c)d+e=f[g]h{i}j',
    '-(+=[]{})',
    'two  spaces',
  ])('accepts %j', async (name) => {
    const { app } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const t = await login(app);
    expect((await setName(app, t, name)).code).toBe(0);
    expect(await names(app, t)).toEqual(one(name));
  });

  // Every refused character measured on cam1, plus non-ASCII letters, a
  // leading or trailing space and the empty name: -54.
  const refused54 = [
    ...['_', '.', ',', "'", '#', '@', '!', ':', ';', '?', '*', '%', '$', '~', '"', '<', '>', '|', '\\', '`', '^'].map((c) => `Cam${c}1`),
    'Café', 'Bär',
    ' Den', 'Den ', ' ',
    '',
  ];
  it.each(refused54)('refuses %j with -54 and keeps the old name', async (name) => {
    const { app } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const t = await login(app);
    expect(await setName(app, t, name)).toEqual({ cmd: 'SetDevName', code: 1, error: { detail: 'the respode of msg is err', rspCode: -54 } });
    expect(await names(app, t)).toEqual(one('Den'));
  });

  it('refuses 32 characters with -56 and keeps the old name', async () => {
    const { app } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const t = await login(app);
    expect(await setName(app, t, 'x'.repeat(32))).toEqual({ cmd: 'SetDevName', code: 1, error: { detail: 'err get data from json', rspCode: -56 } });
    expect(await names(app, t)).toEqual(one('Den'));
  });

  it('SetOsd follows the same rules', async () => {
    const { app } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const t = await login(app);
    const osd = (await post(app, 'GetOsd', { channel: 0 }, t)).reply.value.Osd;
    const withName = (name: string) => ({ Osd: { ...osd, osdChannel: { ...osd.osdChannel, name } } });
    expect((await post(app, 'SetOsd', withName('Den_1'), t)).reply.error.rspCode).toBe(-54);
    expect((await post(app, 'SetOsd', withName(''), t)).reply.error.rspCode).toBe(-54);
    expect((await post(app, 'SetOsd', withName('Den '), t)).reply.error.rspCode).toBe(-54);
    expect((await post(app, 'SetOsd', withName('x'.repeat(32)), t)).reply.error.rspCode).toBe(-56);
    expect(await names(app, t)).toEqual(one('Den'));
  });

  it('persists across a reboot, a power cycle and a restart of the simulator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camsim-name-'));
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Den', CAMSIM_DATA_DIR: dir });
    let t = await login(app);
    await setName(app, t, 'Backyard Left');
    await engine.reboot({ ms: 1, dropsConnection: false });
    t = await login(app);
    expect(await names(app, t)).toEqual(one('Backyard Left'));
    engine.powerOff();
    await engine.powerOn(1);
    t = await login(app);
    expect(await names(app, t)).toEqual(one('Backyard Left'));
    const again = await makeCamera({ CAMSIM_NAME: 'Den', CAMSIM_DATA_DIR: dir });
    t = await login(again.app);
    expect(await names(again.app, t)).toEqual(one('Backyard Left'));
  });

  it('a factory reset brings back CAMSIM_NAME', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Den' });
    let t = await login(app);
    await setName(app, t, 'Backyard Left');
    engine.reset({ settings: true });
    t = await login(app);
    expect(await names(app, t)).toEqual(one('Den'));
  });

  it('the settings.fail fault covers SetDevName', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Den' });
    engine.faults.set({ name: 'settings.fail', cmds: ['SetDevName'], rspCode: -54 });
    const t = await login(app);
    expect((await setName(app, t, 'Garage')).error.rspCode).toBe(-54);
    expect(await names(app, t)).toEqual(one('Den'));
  });
});
