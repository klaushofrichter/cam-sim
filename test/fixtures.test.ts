import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureFixtures, FixtureMedia } from '../src/media/fixtures';
import { readFlv } from '../src/media/flv';
import { createLogger } from '../src/log';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
// CI must have ffmpeg: skipping there would hide a broken fixture build.
if (process.env.CI && !hasFfmpeg) throw new Error('ffmpeg is required in CI');

describe.skipIf(!hasFfmpeg)('fixtures', () => {
  let dir: string;
  let paths: Awaited<ReturnType<typeof ensureFixtures>>;
  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'camsim-fx-')), 'fixtures');
    paths = await ensureFixtures(dir, createLogger('silent'));
  }, 120_000);

  it('makes a JPEG snapshot', () => {
    const b = readFileSync(paths.snapshot);
    expect(b.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('makes fragmented MP4 clips that start with ftyp mp42', () => {
    for (const p of [paths.clipSub, paths.clipMain]) {
      expect(readFileSync(p).subarray(4, 12).toString()).toBe('ftypmp42');
    }
  });

  it('makes a standard H.264 sub FLV and a codec-12 H.265 main FLV, both with AAC', () => {
    const sub = readFlv(readFileSync(paths.subFlv));
    const main = readFlv(readFileSync(paths.mainFlv));
    expect(sub.tags.find((t) => t.type === 9)?.codecId).toBe(7);
    expect(main.tags.find((t) => t.type === 9)?.codecId).toBe(12);
    expect(main.tags.find((t) => t.type === 8)?.codecId).toBe(10);
    const mainVideo = main.tags.filter((t) => t.type === 9);
    expect(mainVideo[0].bytes[12]).toBe(0); // sequence header first
    expect(mainVideo[1].bytes[11]).toBe(0x1c); // then a keyframe
    expect(mainVideo.at(-1)!.ms).toBeGreaterThan(5000);
    const ms = main.tags.map((t) => t.ms);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms); // interleaved by time
  });

  it('main.flv carries H.265 that decodes', () => {
    // Rebuild an Annex B stream from the FLV's config record and NAL units,
    // then let ffprobe decode every frame.
    const { tags } = readFlv(readFileSync(paths.mainFlv));
    const video = tags.filter((t) => t.type === 9).map((t) => t.bytes.subarray(11, t.bytes.length - 4));
    const sc = Buffer.from([0, 0, 0, 1]);
    const out: Buffer[] = [];
    const rec = video[0].subarray(5);
    for (let at = 23, i = 0; i < rec[22]; i++) {
      const len = rec.readUInt16BE(at + 3);
      out.push(sc, rec.subarray(at + 5, at + 5 + len));
      at += 5 + len;
    }
    for (const body of video.slice(1)) {
      for (let at = 5; at < body.length; ) {
        const len = body.readUInt32BE(at);
        out.push(sc, body.subarray(at + 4, at + 4 + len));
        at += 4 + len;
      }
    }
    const file = join(dir, '..', 'check.h265');
    writeFileSync(file, Buffer.concat(out));
    const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,nb_read_frames', '-of', 'json', file]).toString();
    const st = JSON.parse(probe).streams[0];
    expect(st).toMatchObject({ codec_name: 'hevc', width: 1280 });
    expect(Number(st.nb_read_frames)).toBe(120);
  });

  // #24: keyframes as the camera's GetEnc says (and as measured): sub every
  // 4 s at 10 fps, main every 2 s at 20 fps.
  it('puts keyframes where the camera does: sub every 4 s, main every 2 s', () => {
    // Frames between keyframes (FLV timestamps can be unset; frames are
    // exact): 40 frames is 4 s at the sub's 10 fps and 2 s at the main's 20.
    const gaps = (file: string) => {
      const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', file])
        .toString().trim().split('\n').map((l, i) => (l.trim().split(',')[0] === '1' ? i : -1)).filter((i) => i >= 0);
      return keys.slice(1).map((k, i) => k - keys[i]);
    };
    for (const f of [paths.subFlv, paths.clipSub]) expect(gaps(f).length).toBeGreaterThanOrEqual(1);
    for (const f of [paths.subFlv, paths.clipSub, paths.clipMain]) expect(new Set(gaps(f))).toEqual(new Set([40]));
    expect(gaps(paths.clipMain).length).toBeGreaterThanOrEqual(5);
  });

  it('makes 12 s clips, long enough for players to skip 10 s', () => {
    for (const p of [paths.clipSub, paths.clipMain]) {
      const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString());
      expect(d).toBeGreaterThanOrEqual(11.9);
    }
  });

  it('encodes once when several processes ask at the same time', async () => {
    const fresh = join(mkdtempSync(join(tmpdir(), 'camsim-fx-')), 'fixtures');
    const results = await Promise.all([1, 2, 3].map(() => ensureFixtures(fresh, createLogger('silent'))));
    expect(new Set(results.map((r) => r.dir)).size).toBe(1);
    expect(readdirSync(join(fresh, '..')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  }, 120_000);

  it('does not regenerate existing fixtures', async () => {
    const before = statSync(paths.subFlv).mtimeMs;
    await ensureFixtures(dir, createLogger('silent'));
    expect(statSync(paths.subFlv).mtimeMs).toBe(before);
  });

  it('serves them through FixtureMedia', async () => {
    const m = new FixtureMedia(paths);
    expect((await m.snapshot()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(m.liveFlv('main').tags.length).toBeGreaterThan(100);
    expect(m.clipSize('sub')).toBe(statSync(paths.clipSub).size);
    expect(m.clipPath('main')).toBe(paths.clipMain);
    expect(m.durationMs('sub')).toBeGreaterThan(5000);
  });
});
