import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { makeCamera, post, login, listen, rawGet } from '../helpers';
import { fixedClock } from '../../src/engine/clock';

const clock = () => fixedClock(new Date('2026-09-26T17:00:00Z'));
const DAY = { year: 2026, mon: 9, day: 26, hour: 0, min: 0, sec: 0 };
const END = { year: 2026, mon: 9, day: 26, hour: 23, min: 59, sec: 59 };
const search = (app: any, t: string, streamType = 'sub', onlyStatus = 0) =>
  post(app, 'Search', { Search: { channel: 0, onlyStatus, streamType, StartTime: DAY, EndTime: END } }, t);

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function served(env: Record<string, string> = {}) {
  const cam = await makeCamera({ CAMSIM_SEED_CLIPS: 'demo', ...env }, { clock: clock() });
  const srv = await listen(cam.app);
  closers.push(srv.close);
  const t = await login(cam.app);
  const files = (await search(cam.app, t)).reply.value.SearchResult.File;
  return { ...cam, srv, t, files, dl: (name: string, token = t) => `${srv.url}/cgi-bin/api.cgi?cmd=Download&source=${name}&output=x.mp4&token=${token}` };
}

describe('camera API: Search', () => {
  it('lists the day like the firmware', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_SEED_CLIPS: 'demo' }, { clock: clock() });
    const t = await login(app);
    const { reply } = await search(app, t);
    const files = reply.value.SearchResult.File;
    expect(reply.value.SearchResult.channel).toBe(0);
    expect(files).toHaveLength(4);
    expect(files[0]).toMatchObject({ type: 'sub', StartTime: { hour: 8, min: 15, sec: 10 } });
    expect(files[0].name).toMatch(/^\/mnt\/sda\/Mp4Record\/2026-09-26\/RecS0A_DST20260926_081510_081535_0_5514C000000000_[0-9A-F]+\.mp4$/);
    expect(typeof files[0].size).toBe('string');
    expect(engine.counters.searches).toBe(1);
  });

  it('omits File on a day without clips', async () => {
    const { app } = await makeCamera({}, { clock: clock() });
    const t = await login(app);
    expect((await search(app, t)).reply.value.SearchResult).toEqual({ channel: 0 });
  });

  it('answers onlyStatus with the month table', async () => {
    const { app } = await makeCamera({ CAMSIM_SEED_CLIPS: 'demo' }, { clock: clock() });
    const t = await login(app);
    const st = (await search(app, t, 'main', 1)).reply.value.SearchResult.Status[0];
    expect(st.year).toBe(2026);
    expect(st.table[25]).toBe('1');
  });

  it('an overlapping Search from another session gets -54, and the first comes back empty', async () => {
    const { app, engine } = await makeCamera({ CAMSIM_SEED_CLIPS: 'demo' }, { clock: clock() });
    engine.faults.set({ name: 'search.delayMs', ms: 150 });
    const a = await login(app), b = await login(app, 'admin', 'admin-pw');
    const first = search(app, a);
    await new Promise((r) => setTimeout(r, 30));
    const second = await search(app, b);
    expect(second.reply).toEqual({ cmd: 'Search', code: 1, error: { detail: 'the respode of msg is err', rspCode: -54 } });
    expect((await first).reply.value.SearchResult).toEqual({ channel: 0 });
    expect((await search(app, a)).reply.value.SearchResult.File).toHaveLength(4);
  });
});

describe('camera API: Download', () => {
  it('serves a fragmented MP4', async () => {
    const { files, dl, engine } = await served();
    const r = await rawGet(dl(files[0].name));
    if (r === 'reset') throw new Error('reset');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.body.subarray(4, 12).toString()).toBe('ftypmp42');
    expect(engine.counters.downloads).toBe(1);
    expect(engine.counters.downloadOrder).toEqual(['081510']);
  });

  it('serves the main clip for a RecM name, and lowercase download works', async () => {
    const { app, srv, t } = await served();
    const main = (await search(app, t, 'main')).reply.value.SearchResult.File[0].name;
    const r = await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=download&source=${main}&output=x.mp4&token=${t}`);
    if (r === 'reset') throw new Error('reset');
    expect(r.status).toBe(200);
  });

  it('resets on a percent-encoded source', async () => {
    const { files, dl } = await served();
    expect(await rawGet(dl(encodeURIComponent(files[0].name)))).toBe('reset');
  });

  it('answers 401 text/html with an empty body for a bad token', async () => {
    const { files, dl } = await served();
    const r = await rawGet(dl(files[0].name, 'deadbeefdeadbeef'));
    expect(r).toMatchObject({ status: 401, body: Buffer.alloc(0) });
    if (r !== 'reset') expect(r.headers['content-type']).toMatch(/^text\/html/);
  });

  it('answers 404 to user/password instead of a token, and to Playback', async () => {
    const { files, srv } = await served();
    const a = await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=Download&source=${files[0].name}&user=cams&password=cams-pw`);
    expect(a).toMatchObject({ status: 404 });
    const b = await rawGet(`${srv.url}/cgi-bin/api.cgi?cmd=Playback&source=${files[0].name}`);
    expect(b).toMatchObject({ status: 404 });
  });

  it('resets for unknown and traversal paths, reading nothing', async () => {
    const { dl, engine } = await served();
    expect(await rawGet(dl('/mnt/sda/Mp4Record/2026-09-26/RecS0A_nope.mp4'))).toBe('reset');
    expect(await rawGet(dl('/mnt/sda/Mp4Record/../../etc/passwd'))).toBe('reset');
    expect(await rawGet(dl('/etc/passwd'))).toBe('reset');
    expect(engine.counters.downloads).toBe(0);
  });

  it('one download at a time, device-wide', async () => {
    const { app, files, dl, engine } = await served();
    engine.faults.set({ name: 'downloads.delayMs', ms: 300 });
    const other = await login(app, 'admin', 'admin-pw');
    const first = rawGet(dl(files[0].name));
    await new Promise((r) => setTimeout(r, 50));
    expect(await rawGet(dl(files[1].name, other))).toBe('reset');
    expect(await first).toMatchObject({ status: 200 });
  });

  it('CheckDownload reports the task, -4 for unknown names', async () => {
    const { app, t, files } = await served();
    expect((await post(app, 'CheckDownload', { filename: files[0].name }, t)).reply.value).toEqual({ downloadTask: 0 });
    expect((await post(app, 'CheckDownload', { filename: 'x' }, t)).reply).toEqual({ cmd: 'CheckDownload', code: 1, error: { detail: 'param error', rspCode: -4 } });
  });

  it('downloads.refuse and downloads.dropFirst reset and count', async () => {
    const { files, dl, engine } = await served({ CAMSIM_FAULTS: '[{"name":"downloads.dropFirst","count":1}]' });
    expect(await rawGet(dl(files[0].name))).toBe('reset');
    expect(await rawGet(dl(files[0].name))).toMatchObject({ status: 200 });
    engine.faults.set({ name: 'downloads.refuse' });
    expect(await rawGet(dl(files[0].name))).toBe('reset');
    expect(engine.counters.droppedDownloads).toBe(2);
  });

  it('downloads.dropActive ends a transfer in flight', async () => {
    const { files, dl, engine } = await served();
    engine.faults.set({ name: 'downloads.delayMs', ms: 200 });
    const p = rawGet(dl(files[0].name));
    await new Promise((r) => setTimeout(r, 50));
    engine.dropDownloads();
    expect(await p).toBe('reset');
  });

  it('Download needs the HTTP service', async () => {
    const { app, t, files, dl } = await served();
    const np = (await post(app, 'GetNetPort', {}, t)).reply.value.NetPort;
    await post(app, 'SetNetPort', { NetPort: { ...np, httpEnable: 0 } }, t);
    expect(await rawGet(dl(files[0].name))).toBe('reset');
  });
});
