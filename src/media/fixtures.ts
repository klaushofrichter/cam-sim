import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type pino from 'pino';
import { FlvWriter, readFlv, splitAnnexB, h265NalType, hvcc, parseAdts, type FlvTag } from './flv';
import type { MediaSource, Stream } from './source';

const run = promisify(execFile);

// Bump when the generated files change, so caches are rebuilt.
export const FIXTURE_VERSION = 1;

export interface FixturePaths {
  dir: string;
  snapshot: string;
  subFlv: string;
  mainFlv: string;
  clipSub: string;
  clipMain: string;
}

const FILES = { snapshot: 'snapshot.jpg', subFlv: 'sub.flv', mainFlv: 'main.flv', clipSub: 'clip-sub.mp4', clipMain: 'clip-main.mp4' };

export const defaultFixtureDir = () => join(tmpdir(), `cam-sim-fixtures-${FIXTURE_VERSION}`);

function pathsIn(dir: string): FixturePaths {
  return {
    dir,
    snapshot: join(dir, FILES.snapshot),
    subFlv: join(dir, FILES.subFlv),
    mainFlv: join(dir, FILES.mainFlv),
    clipSub: join(dir, FILES.clipSub),
    clipMain: join(dir, FILES.clipMain),
  };
}

function complete(dir: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return m.version === FIXTURE_VERSION && Object.values(FILES).every((f) => existsSync(join(dir, f)));
  } catch {
    return false;
  }
}

const SUB = 'testsrc2=size=896x512:rate=10';
// Main is generated at 1280x720 rather than 4512x2512 so the fixtures build in
// seconds; GetEnc still reports the camera's real sizes.
const MAIN = 'testsrc2=size=1280x720:rate=20';
const TONE = 'sine=frequency=440:sample_rate=16000';
const FRAG = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-brand', 'mp42'];

async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
}

// The camera's main-stream FLV: H.265 with legacy codec id 12, plus AAC,
// interleaved by timestamp.
function composeMainFlv(h265: Buffer, aac: Buffer, fps: number): Buffer {
  const w = new FlvWriter();
  const nalus = splitAnnexB(h265);
  const aus: Buffer[][] = [];
  for (const n of nalus) {
    if (h265NalType(n) === 35 || !aus.length) aus.push([]); // AUD starts an access unit
    aus[aus.length - 1].push(n);
  }
  const find = (t: number) => nalus.find((n) => h265NalType(n) === t);
  const vps = find(32), sps = find(33), pps = find(34);
  if (!vps || !sps || !pps) throw new Error('H.265 fixture has no parameter sets');
  const tags: Array<{ ms: number; order: number; buf: Buffer }> = [];
  tags.push({ ms: 0, order: 0, buf: w.videoConfig('h265', hvcc(vps, sps, pps), 0) });
  let frame = 0;
  for (const au of aus) {
    const vcl = au.filter((n) => h265NalType(n) < 32 || h265NalType(n) === 39 || h265NalType(n) === 40);
    if (!vcl.some((n) => h265NalType(n) < 32)) continue;
    const key = vcl.some((n) => h265NalType(n) >= 16 && h265NalType(n) <= 21);
    const ms = Math.round((frame++ * 1000) / fps);
    tags.push({ ms, order: 2, buf: w.video('h265', vcl, key, ms) });
  }
  const { asc, sampleRate, frames } = parseAdts(aac);
  tags.push({ ms: 0, order: 1, buf: w.audioConfig(asc, 0) });
  frames.forEach((f, i) => {
    const ms = Math.round((i * 1024 * 1000) / sampleRate);
    tags.push({ ms, order: 3, buf: w.audio(f, ms) });
  });
  tags.sort((a, b) => a.ms - b.ms || a.order - b.order);
  return Buffer.concat([w.header(true, true), ...tags.map((t) => t.buf)]);
}

async function generate(dir: string): Promise<void> {
  const p = pathsIn(dir);
  await ffmpeg(['-f', 'lavfi', '-i', SUB, '-frames:v', '1', p.snapshot]);
  await ffmpeg(['-f', 'lavfi', '-i', SUB, '-f', 'lavfi', '-i', TONE, '-t', '6',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '20', '-bf', '0',
    '-c:a', 'aac', '-f', 'flv', p.subFlv]);
  const h265 = join(dir, 'main.h265');
  const aac = join(dir, 'main.aac');
  await ffmpeg(['-f', 'lavfi', '-i', MAIN, '-t', '6', '-c:v', 'libx265', '-pix_fmt', 'yuv420p',
    '-x265-params', 'keyint=40:min-keyint=40:bframes=0:aud=1:repeat-headers=1:log-level=error', '-f', 'hevc', h265]);
  await ffmpeg(['-f', 'lavfi', '-i', TONE, '-t', '6', '-c:a', 'aac', '-f', 'adts', aac]);
  writeFileSync(p.mainFlv, composeMainFlv(readFileSync(h265), readFileSync(aac), 20));
  rmSync(h265);
  rmSync(aac);
  await ffmpeg(['-f', 'lavfi', '-i', SUB, '-f', 'lavfi', '-i', TONE, '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '20', '-c:a', 'aac', ...FRAG, '-f', 'mp4', p.clipSub]);
  await ffmpeg(['-f', 'lavfi', '-i', MAIN, '-f', 'lavfi', '-i', TONE, '-t', '4',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'keyint=40:log-level=error',
    '-c:a', 'aac', ...FRAG, '-f', 'mp4', p.clipMain]);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: FIXTURE_VERSION }));
}

// Generates the test-pattern fixtures once per directory. Generation runs in
// a private temp directory that is renamed into place, so parallel test
// workers can call this at the same time: the first rename wins.
export async function ensureFixtures(dir: string, log: pino.Logger): Promise<FixturePaths> {
  if (complete(dir)) return pathsIn(dir);
  const tmp = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
  mkdirSync(tmp, { recursive: true });
  log.info({ dir }, 'fixtures_generating');
  try {
    await generate(tmp);
    try {
      renameSync(tmp, dir);
    } catch {
      // Another worker finished first (or an old incomplete dir is in the way).
      if (!complete(dir)) {
        rmSync(dir, { recursive: true, force: true });
        renameSync(tmp, dir);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return pathsIn(dir);
}

export class FixtureMedia implements MediaSource {
  private readonly flv = new Map<Stream, { header: Buffer; tags: FlvTag[] }>();

  constructor(private readonly paths: FixturePaths) {}

  async snapshot(): Promise<Buffer> {
    return readFileSync(this.paths.snapshot);
  }

  liveFlv(stream: Stream) {
    let f = this.flv.get(stream);
    if (!f) {
      f = readFlv(readFileSync(stream === 'main' ? this.paths.mainFlv : this.paths.subFlv));
      this.flv.set(stream, f);
    }
    return f;
  }

  durationMs(stream: Stream): number {
    const tags = this.liveFlv(stream).tags;
    return tags.length ? tags[tags.length - 1].ms + 100 : 0;
  }

  clipPath(stream: Stream): string {
    return stream === 'main' ? this.paths.clipMain : this.paths.clipSub;
  }

  clipSize(stream: Stream): number {
    return statSync(this.clipPath(stream)).size;
  }
}
