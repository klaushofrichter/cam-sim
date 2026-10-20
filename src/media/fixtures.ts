import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type pino from 'pino';
import { FlvWriter, readFlv, splitAnnexB, h265NalType, hvcc, parseAdts, type FlvTag } from './flv';
import type { MediaSource, Stream } from './source';
import { sleep } from '../util/sleep';
import { profileFor, type CameraProfile } from '../profile/profile';

const run = promisify(execFile);

// Bump when the generated files change, so caches are rebuilt.
const FIXTURE_VERSION = 3;

export interface FixturePaths {
  dir: string;
  snapshot: string;
  subFlv: string;
  mainFlv: string;
  clipSub: string;
  clipMain: string;
}

const FILES = { snapshot: 'snapshot.jpg', subFlv: 'sub.flv', mainFlv: 'main.flv', clipSub: 'clip-sub.mp4', clipMain: 'clip-main.mp4' };

// What the test pattern is generated as: the model's sub size and frame
// rates (the RLC-1224A's 896x512 at 10 fps and main at 20 fps by default). The
// suffix keeps other models' fixtures apart from the default ones.
export interface FixtureSpec {
  sub: string;
  subFps: number;
  mainFps: number;
  suffix: string;
}

export function fixtureSpec(profile: CameraProfile = profileFor(undefined)): FixtureSpec {
  const { sub, subFps, mainFps } = profile.media;
  const suffix = profile.model === profileFor(undefined).model ? '' : `-${profile.model.toLowerCase()}`;
  return { sub, subFps, mainFps, suffix };
}

export const defaultFixtureDir = (profile?: CameraProfile) => join(tmpdir(), `cam-sim-fixtures-${FIXTURE_VERSION}${fixtureSpec(profile).suffix}`);

export function fixturePaths(dir: string): FixturePaths {
  return {
    dir,
    snapshot: join(dir, FILES.snapshot),
    subFlv: join(dir, FILES.subFlv),
    mainFlv: join(dir, FILES.mainFlv),
    clipSub: join(dir, FILES.clipSub),
    clipMain: join(dir, FILES.clipMain),
  };
}

// The manifest names the model for non-default ones, so a fixture folder is
// only used for the model it was made for.
function manifest(spec: FixtureSpec): Record<string, unknown> {
  return spec.suffix ? { version: FIXTURE_VERSION, model: spec.suffix.slice(1) } : { version: FIXTURE_VERSION };
}

function complete(dir: string, spec: FixtureSpec): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return m.version === FIXTURE_VERSION && m.model === manifest(spec).model && Object.values(FILES).every((f) => existsSync(join(dir, f)));
  } catch {
    return false;
  }
}

const sub = (s: FixtureSpec) => `testsrc2=size=${s.sub}:rate=${s.subFps}`;
// Main is generated at 1280x720 rather than the camera's size (4512x2512 on
// the RLC-1224A) so the fixtures build in seconds; GetEnc still reports the
// camera's real sizes.
const main = (s: FixtureSpec) => `testsrc2=size=1280x720:rate=${s.mainFps}`;
const TONE = 'sine=frequency=440:sample_rate=16000';
const FRAG = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-brand', 'mp42'];
// Fast presets: fixtures build in seconds even on small CI runners.
const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
const X265 = ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
// Clips are 12 s, like the recordings cams' player tests skip through.
const CLIP_S = '12';

// One ffmpeg run, quiet unless it fails (the error carries its stderr).
export async function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024, signal });
}

// The camera's main-stream FLV: H.265 with legacy codec id 12, plus AAC,
// interleaved by timestamp.
export function composeMainFlv(h265: Buffer, aac: Buffer, fps: number): Buffer {
  const w = new FlvWriter();
  const nalus = splitAnnexB(h265);
  const aus: Buffer[][] = [];
  for (const n of nalus) {
    // A new access unit starts at an AUD, or at a picture's first slice
    // (first_slice_segment_in_pic_flag) when the stream has no AUDs, as a
    // camera's stream copy may not.
    const type = h265NalType(n);
    const firstSlice = type < 32 && (n[2] & 0x80) !== 0;
    const last = aus[aus.length - 1];
    const lastHasSlice = !!last?.some((x) => h265NalType(x) < 32);
    const lastIsAud = !!last?.length && h265NalType(last[last.length - 1]) === 35;
    if (!aus.length || type === 35 || (firstSlice && lastHasSlice && !lastIsAud)) aus.push([]);
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

async function generate(dir: string, spec: FixtureSpec): Promise<void> {
  const p = fixturePaths(dir);
  const SUB = sub(spec);
  const MAIN = main(spec);
  await ffmpeg(['-f', 'lavfi', '-i', SUB, '-frames:v', '1', p.snapshot]);
  await ffmpeg(['-f', 'lavfi', '-i', SUB, '-f', 'lavfi', '-i', TONE, '-t', '6',
    ...X264, '-profile:v', 'high', '-g', '40', '-bf', '0',
    '-c:a', 'aac', '-f', 'flv', p.subFlv]);
  const h265 = join(dir, 'main.h265');
  const aac = join(dir, 'main.aac');
  await ffmpeg(['-f', 'lavfi', '-i', MAIN, '-t', '6', ...X265,
    '-x265-params', 'keyint=40:min-keyint=40:bframes=0:aud=1:repeat-headers=1:log-level=error', '-f', 'hevc', h265]);
  await ffmpeg(['-f', 'lavfi', '-i', TONE, '-t', '6', '-c:a', 'aac', '-f', 'adts', aac]);
  writeFileSync(p.mainFlv, composeMainFlv(readFileSync(h265), readFileSync(aac), spec.mainFps));
  rmSync(h265);
  rmSync(aac);
  await ffmpeg(['-f', 'lavfi', '-i', SUB, '-f', 'lavfi', '-i', TONE, '-t', CLIP_S,
    ...X264, '-g', '40', '-c:a', 'aac', ...FRAG, '-f', 'mp4', p.clipSub]);
  await ffmpeg(['-f', 'lavfi', '-i', MAIN, '-f', 'lavfi', '-i', TONE, '-t', CLIP_S,
    ...X265, '-tag:v', 'hvc1', '-x265-params', 'keyint=40:log-level=error',
    '-c:a', 'aac', ...FRAG, '-f', 'mp4', p.clipMain]);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(spec)));
}

const LOCK_STALE_MS = 180_000;

// A lock directory next to the fixtures (mkdir is atomic across processes),
// so parallel test workers wait for one encode instead of all encoding.
async function withLock<T>(dir: string, spec: FixtureSpec, fn: () => Promise<T>): Promise<T> {
  const lock = `${dir}.lock`;
  mkdirSync(join(dir, '..'), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (complete(dir, spec)) return undefined as T;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // the lock went away between the calls
      }
      await sleep(200);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Generates the test-pattern fixtures once per directory: under a lock, into
// a private temp directory that is renamed into place, so parallel test
// workers and processes can all call this at the same time.
export async function ensureFixtures(dir: string, log: pino.Logger, profile?: CameraProfile): Promise<FixturePaths> {
  const spec = fixtureSpec(profile);
  if (complete(dir, spec)) return fixturePaths(dir);
  await withLock(dir, spec, () => build(dir, log, spec));
  if (!complete(dir, spec)) throw new Error(`fixtures in ${dir} are incomplete`);
  return fixturePaths(dir);
}

async function build(dir: string, log: pino.Logger, spec: FixtureSpec): Promise<void> {
  if (complete(dir, spec)) return;
  const tmp = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
  mkdirSync(tmp, { recursive: true });
  log.info({ dir }, 'fixtures_generating');
  try {
    await generate(tmp, spec);
    try {
      renameSync(tmp, dir);
    } catch {
      // Another worker finished first (or an old incomplete dir is in the way).
      if (!complete(dir, spec)) {
        rmSync(dir, { recursive: true, force: true });
        renameSync(tmp, dir);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

  release(): void {
    this.flv.clear();
  }
}
