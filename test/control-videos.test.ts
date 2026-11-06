import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { makeEngine } from './helpers';
import { createControlApp } from '../src/control-api/app';
import { Library } from '../src/media/library';
import { createCamSim } from '../src';
import pino from 'pino';

const TOKEN = 'v'.repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
let src: string;

beforeAll(() => {
  src = mkdtempSync(join(tmpdir(), 'camsim-ctlvid-src-'));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(src, 'Yard.mp4')]);
  writeFileSync(join(src, 'bad.mp4'), 'nope');
}, 60_000);

async function setup(prepare = true) {
  const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: TOKEN, CAMSIM_MAIN_SIZE: '640x360' });
  const lib = new Library(engine, { sourceDir: src, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-ctlvid-cache-')) });
  if (prepare) await lib.prepareAll();
  return { engine, lib, app: createControlApp(engine) };
}

describe('control API: videos', () => {
  it('lists the library with the selected video marked', async () => {
    const { app } = await setup();
    const r = await request(app).get('/sim/api/videos').set(auth);
    expect(r.status).toBe(200);
    expect(r.body.selected).toBe('test-pattern');
    expect(r.body.videos.map((v: { id: string; state: string }) => `${v.id}:${v.state}`)).toEqual(['test-pattern:ready', 'bad:failed', 'yard:ready']);
  }, 60_000);

  it('selects a ready video, and says why it cannot select others', async () => {
    const { app, engine } = await setup();
    expect((await request(app).put('/sim/api/video').set(auth).send({ id: 'yard' })).status).toBe(200);
    expect(engine.state().video).toBe('yard');
    expect((await request(app).get('/sim/api/videos').set(auth)).body.selected).toBe('yard');
    expect((await request(app).put('/sim/api/video').set(auth).send({ id: 'bad' })).status).toBe(409);
    expect((await request(app).put('/sim/api/video').set(auth).send({ id: 'zzz' })).status).toBe(404);
    expect((await request(app).put('/sim/api/video').set(auth).send({ id: 3 })).status).toBe(400);
  }, 60_000);

  it('reset puts the test pattern back (everything, or video only)', async () => {
    const { app, engine } = await setup();
    await request(app).put('/sim/api/video').set(auth).send({ id: 'yard' });
    await request(app).post('/sim/api/reset').set(auth).send({ settings: true });
    expect(engine.videoId).toBe('yard');
    await request(app).post('/sim/api/reset').set(auth).send({ video: true });
    expect(engine.videoId).toBe('test-pattern');
    await request(app).put('/sim/api/video').set(auth).send({ id: 'yard' });
    await request(app).post('/sim/api/reset').set(auth).send({});
    expect(engine.videoId).toBe('test-pattern');
  }, 60_000);

  it('answers 409 for a video still being prepared', async () => {
    const { app } = await setup(false);
    expect((await request(app).put('/sim/api/video').set(auth).send({ id: 'yard' })).status).toBe(409);
  });

  it('serves a poster for each ready video', async () => {
    const { app } = await setup();
    const r = await request(app).get('/sim/api/videos/yard/poster').set(auth);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect((r.body as Buffer).subarray(0, 2).toString('hex')).toBe('ffd8');
    expect((await request(app).get('/sim/api/videos/test-pattern/poster').set(auth)).status).toBe(200);
    expect((await request(app).get('/sim/api/videos/bad/poster').set(auth)).status).toBe(404);
    expect((await request(app).get('/sim/api/videos/zzz/poster').set(auth)).status).toBe(404);
  }, 60_000);

  it('without a library, the test pattern is the only video', async () => {
    const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: TOKEN });
    const r = await request(createControlApp(engine)).get('/sim/api/videos').set(auth);
    expect(r.body).toMatchObject({ selected: 'test-pattern', videos: [{ id: 'test-pattern', state: 'ready' }] });
  });

  it('prepares the library folder at start and selects CAMSIM_VIDEO once ready', async () => {
    const sim = await createCamSim({ users: [{ name: 'admin', password: 'pw', level: 'admin' }], libraryDir: src, video: 'yard', mainSize: '640x360', dataDir: mkdtempSync(join(tmpdir(), 'camsim-ctlvid-data-')) });
    try {
      await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 }, '127.0.0.1');
      expect(sim.engine.videoId).toBe('test-pattern');
      await expect.poll(() => sim.engine.videoId, { timeout: 30_000 }).toBe('yard');
      expect(sim.engine.library!.list().map((v) => v.id)).toEqual(['test-pattern', 'bad', 'yard']);
    } finally {
      await sim.close();
    }
  }, 60_000);

  describe('sequences', () => {
    let seq: string;
    const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

    beforeAll(() => {
      seq = mkdtempSync(join(tmpdir(), 'camsim-ctlseq-src-'));
      for (const n of ['A', 'B']) ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(seq, `${n}.mp4`)]);
      // A captured pair (copied) with another x265 preset than the sim's own conversion.
      mkdirSync(join(seq, 'odd'));
      ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=16000', '-t', '2', '-c:v', 'libx265', '-preset', 'medium', '-x265-params', 'keyint=30:bframes=0:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(seq, 'odd', 'main.mp4')]);
      ff(['-f', 'lavfi', '-i', 'testsrc2=size=896x512:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=16000', '-t', '2', '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(seq, 'odd', 'sub.mp4')]);
    }, 60_000);

    async function setupSeq() {
      const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: TOKEN, CAMSIM_MAIN_SIZE: '640x360' });
      const lib = new Library(engine, { sourceDir: seq, cacheDir: mkdtempSync(join(tmpdir(), 'camsim-ctlseq-cache-')) });
      await lib.prepareAll();
      return { engine, lib, app: createControlApp(engine) };
    }
    const put = (app: any, body: unknown) => request(app).put('/sim/api/video').set(auth).send(body as object);

    it('PUT {ids:[a,b]} selects a sequence', async () => {
      const { app, engine } = await setupSeq();
      const r = await put(app, { ids: ['a', 'b'] });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ selected: 'a', sequence: ['a', 'b'] });
      expect(engine.state()).toMatchObject({ video: 'a', sequence: ['a', 'b'] });
      const g = (await request(app).get('/sim/api/videos').set(auth)).body;
      expect(g).toMatchObject({ selected: 'a', sequence: ['a', 'b'], playing: 'a' });
      expect(g.videos.find((v: { id: string }) => v.id === 'a').compat).toBeTruthy();
    }, 90_000);

    it('refuses an incompatible video, naming it', async () => {
      const { app, engine } = await setupSeq();
      const r = await put(app, { ids: ['a', 'b', 'odd'] });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('incompatible');
      expect(r.body.detail).toContain('odd');
      expect(r.body.detail).not.toContain('b,');
      expect(engine.videoId).toBe('test-pattern');
    }, 90_000);

    it('refuses the test pattern in a sequence', async () => {
      const { app } = await setupSeq();
      const r = await put(app, { ids: ['test-pattern', 'a'] });
      expect(r.status).toBe(400);
      expect(r.body.detail).toContain("test pattern can't be part of a sequence");
    }, 90_000);

    it('refuses duplicates, an empty list, bad ids and unknown or unready ones', async () => {
      const { app } = await setupSeq();
      expect((await put(app, { ids: ['a', 'a'] })).status).toBe(400);
      expect((await put(app, { ids: [] })).status).toBe(400);
      expect((await put(app, { ids: ['a', 3] })).status).toBe(400);
      expect((await put(app, { ids: Array.from({ length: 33 }, (_, i) => `v${i}`) })).status).toBe(400);
      expect((await put(app, { ids: ['a', 'zzz'] })).status).toBe(404);
      expect((await put(app, { id: 'a', ids: ['a', 'b'] })).status).toBe(400);
    }, 90_000);

    it('one id behaves as before', async () => {
      const { app, engine } = await setupSeq();
      const one = await put(app, { ids: ['a'] });
      const state = engine.state();
      const old = await put(app, { id: 'a' });
      expect(one.status).toBe(200);
      expect(one.body).toEqual({ selected: 'a', sequence: ['a'] });
      expect(old.body).toEqual(one.body);
      expect(engine.state()).toEqual({ ...state, events: expect.anything() });
    }, 90_000);

    it('the test pattern after a sequence', async () => {
      const { app } = await setupSeq();
      await put(app, { ids: ['a', 'b'] });
      const r = await put(app, { id: 'test-pattern' });
      expect(r.body).toEqual({ selected: 'test-pattern', sequence: ['test-pattern'] });
      expect((await request(app).get('/sim/api/videos').set(auth)).body).toMatchObject({ sequence: ['test-pattern'], playing: 'test-pattern' });
    }, 90_000);

    it('a recording starts with the video playing', async () => {
      const { app, engine } = await setupSeq();
      await put(app, { ids: ['a', 'b'] });
      engine.events.trigger('motion', 5);
      expect(engine.sd.all().at(-1)?.video).toBe('a');
    }, 90_000);

    it('CAMSIM_VIDEO list selects the sequence after preparation; the test pattern in it is refused and logged', async () => {
      for (const [video, ok] of [['a,b', true], ['a,test-pattern', false]] as const) {
        const lines: string[] = [];
        const log = pino({ level: 'warn' }, { write: (c: string) => void lines.push(c) });
        const sim = await createCamSim({ users: [{ name: 'admin', password: 'pw', level: 'admin' }], libraryDir: seq, video, mainSize: '640x360', dataDir: mkdtempSync(join(tmpdir(), 'camsim-ctlseq-data-')), log });
        try {
          await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 }, '127.0.0.1');
          if (ok) await expect.poll(() => sim.engine.sequence, { timeout: 60_000 }).toEqual(['a', 'b']);
          else {
            await expect.poll(() => lines.join(''), { timeout: 60_000 }).toContain('video_not_selected');
            expect(sim.engine.videoId).toBe('test-pattern');
          }
        } finally {
          await sim.close();
        }
      }
    }, 150_000);
  });
});
