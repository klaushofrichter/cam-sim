import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { makeEngine } from './helpers';
import { createControlApp } from '../src/control-api/app';
import { Library } from '../src/media/library';
import { createCamSim } from '../src';

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
});
