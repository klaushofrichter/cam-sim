import { describe, it, expect, afterEach } from 'vitest';
import { startBc, closeAll, until, sleep, track, DEMO } from './harness';
import { downloadXml, fileInfoRequestXml, stopXml, type BcClient } from './client';
import { aesEncrypt } from '../../src/baichuan/cipher';
import { EXT_BINARY, EXT_CHUNK, tagValue } from '../../src/baichuan/xml';
import { chunkSizes, infoRecord } from '../../src/baichuan/records';
import { resolveFile, timesOf } from '../../src/baichuan/vod';
import { createCameraApp } from '../../src/camera-api/app';
import { listen, login, rawGet } from '../helpers';
import type { Engine } from '../../src/engine/engine';

afterEach(closeAll);

const sizeFromName = (name: string) => parseInt(/_([0-9A-F]+)\.mp4$/.exec(name)![1], 16);

// The same file over HTTP Download (the reference for byte equality).
async function withHttp(engine: Engine) {
  const app = createCameraApp(engine, { port: 'http' });
  const srv = await listen(app);
  track(srv.close);
  const t = await login(app);
  const url = (name: string) => `${srv.url}/cgi-bin/api.cgi?cmd=Download&source=${name}&output=x.mp4&token=${t}`;
  return { url, download: async (name: string) => Buffer.from(await (await fetch(url(name))).arrayBuffer()) };
}

const framesOf = (c: BcClient, msgId: number) => c.frames.filter((f) => f.header.cmd === 8 && f.header.msgId === msgId);

describe('Baichuan recordings: files', () => {
  it('names, Search sizes and file sizes agree for every seeded recording', async () => {
    const { engine } = await startBc({ env: DEMO });
    const recs = engine.sd.all();
    expect(recs).toHaveLength(6);
    for (const rec of recs) {
      for (const s of ['sub', 'main'] as const) {
        const f = rec.files[s];
        const day = { year: Number(rec.date.slice(0, 4)), mon: Number(rec.date.slice(5, 7)), day: Number(rec.date.slice(8, 10)), hour: 0, min: 0, sec: 0 };
        const listed = engine.sd.search(s, day, { ...day, hour: 23, min: 59, sec: 59 }).find((x) => x.name === f.name);
        expect(sizeFromName(f.name)).toBe(f.size);
        expect(Number(listed?.size)).toBe(f.size);
        expect(resolveFile(engine, f.name)?.size).toBe(f.size);
      }
    }
  });
});

describe('Baichuan recordings: cmd 8', () => {
  it('sub and main downloads equal the HTTP Download, after the 32-byte record; chunks as traced (vod-nosearch.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    for (const s of ['sub', 'main'] as const) {
      const { name, size } = rec.files[s];
      const r = await c.download(name, size);
      expect(r.status).toBe(200);
      expect(r.data.length).toBe(size);
      expect(r.data.equals(await http.download(name))).toBe(true);
      const main = s === 'main';
      expect(r.info).toEqual(infoRecord({ width: main ? 4512 : 896, height: main ? 2512 : 512, fps: main ? 20 : 10, main, ...timesOf(rec, s) }));
      const frames = framesOf(c, r.msgId);
      expect(frames[0].header).toMatchObject({ status: 200, payloadOffset: 106, bodyLen: 138 });
      expect(c.text(frames[0], 'ext')).toBe(EXT_BINARY);
      expect(frames.slice(1).map((f) => f.body.length)).toEqual(chunkSizes(size));
      for (const f of frames.slice(1)) {
        expect(f.header.payloadOffset).toBe(136);
        expect(c.text(f, 'ext')).toBe(EXT_CHUNK);
      }
      // Partial encryption: a chunk's first 1024 bytes are AES, the rest is the file as is.
      expect(frames[1].body.subarray(0, 1024)).toEqual(aesEncrypt(c.key!, r.data.subarray(0, 1024)));
      expect(frames[1].body.subarray(1024)).toEqual(r.data.subarray(1024, frames[1].body.length));
      expect((await c.call(9, stopXml())).header).toMatchObject({ status: 200, bodyLen: 0 });
    }
    expect(engine.counters.baichuanDownloads).toBe(2);
    expect(engine.requests.recent(20).find((x) => x.port === 'baichuan' && x.cmd === '8')).toMatchObject({ status: 200, replyLen: 138 });
  });

  it('a <name> in cmd 8 changes nothing', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    const plain = await c.download(rec.files.sub.name, rec.files.sub.size);
    const named = await c.download(rec.files.sub.name, rec.files.sub.size, { name: `01${rec.date.replaceAll('-', '')}${rec.start}` });
    expect(named.data.equals(plain.data)).toBe(true);
  });

  it('an unknown file answers 400 with no body and no chunks; baichuan.refuse does the same (err-notfound.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const c = await loggedIn();
    const r = await c.download('/mnt/sda/Mp4Record/2026-10-02/nothing.mp4', 1);
    expect(r.status).toBe(400);
    expect(framesOf(c, r.msgId)[0].header.bodyLen).toBe(0);
    const { name, size } = engine.sd.all()[0].files.sub;
    engine.faults.set({ name: 'baichuan.refuse', count: 1 });
    expect((await c.download(name, size)).status).toBe(400);
    await sleep(300);
    expect(c.frames.filter((f) => f.header.cmd === 8 && f.header.status === 200)).toHaveLength(0);
    expect((await c.download(name, size)).status).toBe(200);
    expect(engine.counters.baichuanDownloads).toBe(1);
  });
});

describe('Baichuan recordings: stop, replace, parallel', () => {
  it('cmd 9 answers 200; 13 more chunks follow under the old id, then nothing; the next cmd 8 works (abort.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    engine.faults.set({ name: 'baichuan.delayMs', ms: 20 });
    const old = c.send(8, downloadXml(rec.files.main.name));
    let i = 0;
    for (let n = 0; n < 6; n++) i = (await c.waitIndex((f) => f.header.msgId === old, 3000, i)) + 1; // the record and 5 chunks
    const stop = c.send(9, stopXml());
    const at = await c.waitIndex((f) => f.header.cmd === 9 && f.header.msgId === stop);
    expect(c.frames[at].header).toMatchObject({ status: 200, bodyLen: 0 });
    await sleep(800);
    expect(c.frames.slice(at + 1).filter((f) => f.header.msgId === old)).toHaveLength(13);
    expect(framesOf(c, old).length - 1).toBeLessThan(chunkSizes(rec.files.main.size).length);
    engine.faults.clear('baichuan.delayMs');
    const next = await c.download(rec.files.sub.name, rec.files.sub.size);
    expect(next.data.equals(await http.download(rec.files.sub.name))).toBe(true);
  });

  it('a second cmd 8 on the connection silently replaces the running one (err-second-download.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    engine.faults.set({ name: 'baichuan.delayMs', ms: 10 });
    const first = c.send(8, downloadXml(rec.files.main.name));
    await c.waitIndex((f) => f.header.msgId === first && f.header.payloadOffset === 136);
    const r = await c.download(rec.files.sub.name, rec.files.sub.size);
    expect(r.data.equals(await http.download(rec.files.sub.name))).toBe(true);
    const firstNew = c.frames.findIndex((f) => f.header.msgId === r.msgId);
    expect(c.frames.slice(firstNew).some((f) => f.header.msgId === first)).toBe(false);
    expect(framesOf(c, first).length - 1).toBeLessThan(chunkSizes(rec.files.main.size).length);
  });

  it('two connections download in parallel', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const { name, size } = engine.sd.all()[0].files.main;
    const expected = await http.download(name);
    engine.faults.set({ name: 'baichuan.delayMs', ms: 5 });
    const a = await loggedIn();
    const b = await loggedIn();
    const [ra, rb] = await Promise.all([a.download(name, size, { ms: 10_000 }), b.download(name, size, { ms: 10_000 })]);
    expect(ra.data.equals(expected)).toBe(true);
    expect(rb.data.equals(expected)).toBe(true);
    const at = (c: BcClient, id: number) => c.times.filter((_, k) => c.frames[k].header.msgId === id);
    const ta = at(a, ra.msgId);
    const tb = at(b, rb.msgId);
    expect(tb[0]).toBeLessThan(ta[ta.length - 1]);
    expect(ta[0]).toBeLessThan(tb[tb.length - 1]);
  });
});

describe('Baichuan recordings: cmd 13', () => {
  it('the Id size without <name>, the MAIN size with it, handle 0; 431 and 400 for unknown files (fileinfo.txt, err-notfound.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    const startName = `01${rec.date.replaceAll('-', '')}${rec.start}`;
    const info = async (id: string, name?: string) => {
      const f = await c.call(13, fileInfoRequestXml(id, name));
      return { status: f.header.status, xml: c.text(f) };
    };
    const sub = await info(rec.files.sub.name);
    expect(sub.status).toBe(200);
    expect(tagValue(sub.xml, 'sizeL')).toBe(String(rec.files.sub.size));
    expect(tagValue(sub.xml, 'sizeH')).toBe('0');
    expect(tagValue(sub.xml, 'handle')).toBe('0');
    expect(tagValue(sub.xml, 'name')).toBe('');
    const subNamed = await info(rec.files.sub.name, startName);
    expect(tagValue(subNamed.xml, 'sizeL')).toBe(String(rec.files.main.size));
    expect(tagValue(subNamed.xml, 'name')).toBe(startName);
    expect(tagValue((await info(rec.files.main.name)).xml, 'sizeL')).toBe(String(rec.files.main.size));
    expect(await info('/mnt/sda/Mp4Record/2026-10-02/nothing.mp4')).toEqual({ status: 431, xml: '' });
    expect(await info('/mnt/sda/Mp4Record/2026-10-02/nothing.mp4', '0120200101013000')).toEqual({ status: 400, xml: '' });
  });
});

describe('Baichuan recordings: faults and device actions', () => {
  it('baichuan.dropMidway closes the connection halfway through', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const { name, size } = engine.sd.all()[0].files.main;
    engine.faults.set({ name: 'baichuan.dropMidway' });
    const c = await loggedIn();
    await expect(c.download(name, size)).rejects.toThrow(/closed/);
    const got = c.frames.filter((f) => f.header.cmd === 8).slice(1).reduce((n, f) => n + f.body.length, 0);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThanOrEqual(size / 2);
    expect(engine.counters.droppedBaichuanDownloads).toBe(1);
  });

  it('baichuan.delayMs waits before each chunk', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const { name, size } = engine.sd.all()[0].files.sub;
    engine.faults.set({ name: 'baichuan.delayMs', ms: 30 });
    const c = await loggedIn();
    const t0 = Date.now();
    expect((await c.download(name, size, { ms: 5000 })).data.length).toBe(size);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30 * chunkSizes(size).length - 10);
  });

  it('downloads.dropActive also cuts Baichuan transfers', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const { name } = engine.sd.all()[0].files.main;
    engine.faults.set({ name: 'baichuan.delayMs', ms: 20 });
    const c = await loggedIn();
    const id = c.send(8, downloadXml(name));
    await c.waitIndex((f) => f.header.msgId === id && f.header.payloadOffset === 136);
    engine.dropDownloads();
    expect(['eof', 'reset']).toContain(await c.ended);
    expect(engine.counters.droppedBaichuanDownloads).toBe(1);
  });

  it('with downloads.refuse on, HTTP Download resets and Baichuan still works', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const { name, size } = engine.sd.all()[0].files.sub;
    engine.faults.set({ name: 'downloads.refuse' });
    expect(await rawGet(http.url(name))).toBe('reset');
    const r = await (await loggedIn()).download(name, size);
    expect(r.status).toBe(200);
    expect(r.data.length).toBe(size);
    expect(engine.counters.downloads).toBe(0);
    expect(engine.counters.baichuanDownloads).toBe(1);
  });

  it('a running download keeps the connection open past the idle time (chosen, not measured)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO, idleMs: 300 });
    const { name, size } = engine.sd.all()[0].files.main;
    engine.faults.set({ name: 'baichuan.delayMs', ms: 10 }); // about 70 chunks: far past 300 ms
    const c = await loggedIn();
    expect((await c.download(name, size, { ms: 5000 })).data.length).toBe(size);
    expect(await c.ended).toBe('eof'); // then the idle close
  });
});

describe('Baichuan recordings: backpressure', () => {
  // The main fixture (about 2.3 MB) is larger than the loopback buffers on
  // macOS and Linux, so a paused reader makes the transfer wait for drain.
  it('a reader that stops reading slows the transfer instead of growing the buffer', async () => {
    const { engine, loggedIn, server } = await startBc({ env: DEMO });
    const { name, size } = engine.sd.all()[0].files.main;
    const c = await loggedIn();
    c.socket.pause();
    const id = c.send(8, downloadXml(name));
    await until(() => server.writeBacklog() > 0, 3000);
    let max = 0;
    for (let k = 0; k < 25; k++) {
      await sleep(20);
      max = Math.max(max, server.writeBacklog());
    }
    expect(max).toBeLessThan(128 * 1024);
    c.socket.resume();
    expect((await c.collect(id, size)).data.length).toBe(size);
  });

  // Review Focus 3.
  it('a client that disappears while its transfer waits for drain: the transfer ends and the session goes', async () => {
    const { engine, loggedIn, server } = await startBc({ env: DEMO });
    const { name } = engine.sd.all()[0].files.main;
    const c = await loggedIn();
    c.socket.pause();
    c.send(8, downloadXml(name));
    await until(() => server.writeBacklog() > 0, 3000);
    c.close();
    await until(() => server.connectionCount() === 0);
    expect(engine.counters.baichuanSessions).toBe(0);
    expect(engine.sessions.online()).toEqual([]);
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
