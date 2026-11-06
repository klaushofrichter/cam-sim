import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import http from 'http';
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import pino from 'pino';
import { FlvStreamParser, isConfigTag, isKeyframe } from '../src/media/flv-stream';
import { FlvWriter, readFlv, type FlvTag } from '../src/media/flv';
import { ensureFixtures, defaultFixtureDir } from '../src/media/fixtures';
import { createLogger } from '../src/log';
import { makeEngine, listen, login } from './helpers';
import { createCameraApp } from '../src/camera-api/app';
import { Library } from '../src/media/library';
import { SequenceMedia } from '../src/media/sequence';

describe('FlvStreamParser', () => {
  it('yields the same header and tags as readFlv, whatever the chunking', async () => {
    const paths = await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
    const buf = readFileSync(paths.subFlv);
    const want = readFlv(buf);
    for (const size of [1, 7, 11, 15, 4096, buf.length]) {
      const p = new FlvStreamParser();
      let header: Buffer | undefined;
      const tags: FlvTag[] = [];
      p.on('header', (h: Buffer) => (header = h));
      p.on('tag', (t: FlvTag) => tags.push(t));
      for (let i = 0; i < buf.length; i += size) p.push(buf.subarray(i, i + size));
      expect(header?.equals(want.header)).toBe(true);
      expect(tags.map((t) => [t.type, t.ms, t.bytes.length])).toEqual(want.tags.map((t) => [t.type, t.ms, t.bytes.length]));
    }
  });

  it('emits whole copies: codec ids and timestamps above 24 bits as readFlv, bytes not tied to the chunk', () => {
    const w = new FlvWriter();
    const nalu = Buffer.from([0x26, 0x01, 0xaf, 0x00]);
    const buf = Buffer.concat([w.header(true, true), w.video('h265', [nalu], true, 0x1234567), w.audio(Buffer.from([1, 2, 3]), 0x2000000), w.video('h264', [nalu], false, 5)]);
    const want = readFlv(buf).tags;
    expect(want.map((t) => [t.type, t.codecId, t.ms])).toEqual([[9, 12, 0x1234567], [8, 10, 0x2000000], [9, 7, 5]]);
    const chunk = Buffer.from(buf);
    const tags: FlvTag[] = [];
    const p = new FlvStreamParser();
    p.on('tag', (t: FlvTag) => tags.push(t));
    p.push(chunk);
    chunk.fill(0);
    expect(tags).toEqual(want);
  });

  it('classifies config tags and keyframes', async () => {
    const paths = await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
    const { tags } = readFlv(readFileSync(paths.subFlv));
    const video = tags.filter((t) => t.type === 9);
    expect(isConfigTag(video[0])).toBe(true); // AVC sequence header first
    expect(isKeyframe(video[1])).toBe(true); // then a keyframe
    expect(video.slice(1).some((t) => !isKeyframe(t))).toBe(true);
  });
});

// Video sequences (spec 2026-11-06, Playing): every FLV reader joins at the
// sequence clock, at the keyframe at or before it, not at video 1.
describe('FLV readers of a sequence', () => {
  let srcDir: string;
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length) await cleanups.pop()!();
  });

  beforeAll(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'camsim-flvseq-src-'));
    // Two pictures (so each tag tells which video it is from), one recipe
    // (so the sim's conversions are compatible).
    for (const [n, pic] of [['A', 'testsrc2'], ['B', 'testsrc']]) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${pic}=size=320x240:rate=15`, '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(srcDir, `${n}.mp4`)]);
    }
  }, 60_000);

  async function setup(log?: pino.Logger) {
    const engine = await makeEngine({ CAMSIM_MAIN_SIZE: '640x360' }, log ? { log } : {});
    const cacheDir = mkdtempSync(join(tmpdir(), 'camsim-flvseq-cache-'));
    const lib = new Library(engine, { sourceDir: srcDir, cacheDir });
    await lib.prepareAll();
    const app = createCameraApp(engine, { port: 'http' });
    const srv = await listen(app);
    cleanups.push(srv.close, () => engine.stop());
    const token = await login(app);
    return { engine, lib, cacheDir, srv, token };
  }

  // The payload after the 11-byte tag header (which holds the rewritten
  // timestamp) identifies a tag of a video.
  const payload = (t: FlvTag) => t.bytes.subarray(11).toString('base64');
  const media = (t: FlvTag) => (t.type === 8 || t.type === 9) && !isConfigTag(t);

  function read(url: string): { tags: FlvTag[]; closed: () => boolean } {
    const tags: FlvTag[] = [];
    let closed = false;
    const parser = new FlvStreamParser();
    parser.on('tag', (t: FlvTag) => tags.push(t));
    const req = http.get(url, (res) => {
      res.on('data', (d: Buffer) => parser.push(d));
      res.on('close', () => (closed = true));
    });
    req.on('error', () => (closed = true));
    cleanups.push(() => void req.destroy());
    return { tags, closed: () => closed };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The sequence clock (and the stream's pacing) run on Date.now: moving it
  // ahead by a constant keeps the pacing and moves the clock.
  const advance = (ms: number) => {
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + ms);
  };

  it('a reader joining a sequence starts at the clock\'s keyframe', async () => {
    const { engine, lib, srv, token } = await setup();
    expect(lib.selectSequence(['a', 'b'])).toBeNull();
    const bTags = new Set(engine.mediaFor({ video: 'b' }).liveFlv('main').tags.filter(media).map(payload));
    advance(engine.mediaFor({ video: 'a' }).durationMs('main') + 300);
    const r = read(`${srv.url}/flv?port=1935&app=bcs&stream=channel0_main.bcs&token=${token}`);
    await wait(1000);
    const first = r.tags.find(media)!;
    expect(first.type).toBe(9);
    expect(isKeyframe(first)).toBe(true);
    expect(bTags.has(payload(first))).toBe(true);
    expect(r.tags.filter(isConfigTag).length).toBeGreaterThan(0);
    expect(r.tags.findIndex(media)).toBeGreaterThan(r.tags.findLastIndex(isConfigTag));
  }, 90_000);

  it('timestamps rise across the switch inside a sequence', async () => {
    const { engine, lib, srv, token } = await setup();
    expect(lib.selectSequence(['a', 'b'])).toBeNull();
    const aTags = new Set(engine.mediaFor({ video: 'a' }).liveFlv('main').tags.filter(media).map(payload));
    const bTags = new Set(engine.mediaFor({ video: 'b' }).liveFlv('main').tags.filter(media).map(payload));
    // Join in video b, then read across the loop (b → a) and the switch (a → b).
    advance(engine.mediaFor({ video: 'a' }).durationMs('main') + 300);
    const r = read(`${srv.url}/flv?port=1935&app=bcs&stream=channel0_main.bcs&token=${token}`);
    await wait(6500);
    const video = r.tags.filter((t) => t.type === 9 && !isConfigTag(t));
    for (let i = 1; i < video.length; i++) expect(video[i].ms).toBeGreaterThan(video[i - 1].ms);
    const from = video.map((t) => (bTags.has(payload(t)) ? 'b' : aTags.has(payload(t)) ? 'a' : '?'));
    expect(from.join('').replace(/(.)\1+/g, '$1')).toMatch(/^bab/);
    expect(r.tags.filter((t) => t.type === 9 && isConfigTag(t))).toHaveLength(1);
    expect(r.tags.findIndex(isConfigTag)).toBeLessThan(r.tags.findIndex(media));
  }, 90_000);

  it('a single video still starts at its beginning', async () => {
    const { engine, lib, srv, token } = await setup();
    expect(lib.selectSequence(['b'])).toBeNull();
    const own = engine.mediaFor({ video: 'b' }).liveFlv('main').tags.filter(media);
    advance(1500);
    const r = read(`${srv.url}/flv?port=1935&app=bcs&stream=channel0_main.bcs&token=${token}`);
    await wait(1000);
    const first = r.tags.find(media)!;
    expect(payload(first)).toBe(payload(own[0]));
    expect(first.ms).toBe(own[0].ms);
  }, 90_000);

  it('a sequence video whose files vanish ends the stream, not the process', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'warn' }, { write: (c: string) => void lines.push(c) });
    const { engine, srv, token, cacheDir } = await setup(log);
    // Selected without its FLV held in memory, then b's main.flv is gone.
    const b = engine.mediaFor({ video: 'b' });
    b.release?.();
    const dirB = readdirSync(cacheDir).find((d) => d.startsWith('b-'))!;
    rmSync(join(cacheDir, dirB, 'main.flv'));
    const seq = new SequenceMedia([{ id: 'a', media: engine.mediaFor({ video: 'a' }) }, { id: 'b', media: b }], { listDir: join(cacheDir, '.sequence') });
    engine.setMedia(seq, 'a', ['a', 'b']);
    const r = read(`${srv.url}/flv?port=1935&app=bcs&stream=channel0_main.bcs&token=${token}`);
    await expect.poll(() => r.closed(), { timeout: 5000 }).toBe(true);
    expect(r.tags.filter(media)).toHaveLength(0);
    expect(lines.some((l) => /flv_source_failed|flv_switch_failed/.test(l))).toBe(true);
    expect(engine.activeFlv.size).toBe(0);
  }, 90_000);
});
