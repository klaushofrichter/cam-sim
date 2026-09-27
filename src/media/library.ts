import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { basename, extname, join, resolve } from 'path';
import { promisify } from 'util';
import type { Engine } from '../engine/engine';
import { FixtureMedia, composeMainFlv, fixturePaths } from './fixtures';

const run = promisify(execFile);
// Bump when the prepared files change, so caches are rebuilt.
const LIBRARY_VERSION = 2;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.webm']);
const FRAG = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-brand', 'mp42'];

export interface VideoEntry {
  id: string;
  name: string;
  state: 'pending' | 'preparing' | 'ready' | 'failed';
  converted?: boolean; // false: a captured pair in the camera's formats, copied
  durationS?: number;
  error?: string;
}

interface Source {
  id: string;
  name: string;
  kind: 'pair' | 'file';
  paths: string[]; // pair: [main, sub]; file: [file]
}

const hash = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
// Ids are short and path-safe; long names keep a hash of the full name.
function slug(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';
  return s.length <= 40 ? s : `${s.slice(0, 33).replace(/-$/, '')}-${hash(name, 6)}`;
}
// ffmpeg reads a plain absolute path (no protocol like concat:, no option-like '-').
const input = (p: string) => `file:${resolve(p)}`;
const STALE_TMP_MS = 3600_000;

async function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024, signal });
}

async function probe(file: string): Promise<{ vcodec?: string; acodec?: string; duration: number; fps: number }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate:format=duration', '-of', 'json', input(file)]);
  const j = JSON.parse(stdout) as { streams?: Array<{ codec_type: string; codec_name: string; avg_frame_rate?: string }>; format?: { duration?: string } };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const [n, d] = (v?.avg_frame_rate ?? '20/1').split('/').map(Number);
  return { vcodec: v?.codec_name, acodec: a?.codec_name, duration: Number(j.format?.duration ?? 0), fps: d ? n / d : 20 };
}

// The video library: the built-in test pattern plus every video in the
// source folder (CAMSIM_LIBRARY_DIR), each prepared once into the camera's
// formats and cached. Selecting one switches live video, snapshots, RTSP and
// recordings to it.
export class Library {
  private readonly entries = new Map<string, VideoEntry>();
  private readonly sources = new Map<string, Source>();
  private readonly abort = new AbortController();

  constructor(private readonly engine: Engine, private readonly opts: { sourceDir?: string; cacheDir: string }) {
    engine.library = this;
    this.entries.set('test-pattern', { id: 'test-pattern', name: 'Test pattern', state: 'ready', converted: true });
    // Every cached copy stays servable, so recordings keep their video after
    // a restart, also when its source was removed.
    for (const [id, dir] of this.cachedCopies()) engine.registerMedia(id, new FixtureMedia(fixturePaths(dir)));
    for (const s of this.scan()) {
      this.sources.set(s.id, s);
      const e: VideoEntry = { id: s.id, name: s.name, state: 'pending' };
      this.entries.set(s.id, e);
      try {
        const meta = this.readMeta(this.dirFor(s));
        if (meta) {
          Object.assign(e, { state: 'ready', converted: meta.converted, durationS: meta.durationS });
          engine.registerMedia(s.id, new FixtureMedia(fixturePaths(this.dirFor(s))));
        }
      } catch {
        // the source vanished while scanning: prepareAll reports it
      }
    }
  }

  private readMeta(dir: string): { id: string; key: string; converted: boolean; durationS: number } | undefined {
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      const p = fixturePaths(dir);
      if (meta.version !== LIBRARY_VERSION || typeof meta.id !== 'string') return undefined;
      if (![p.snapshot, p.subFlv, p.mainFlv, p.clipSub, p.clipMain].every((f) => existsSync(f))) return undefined;
      return meta;
    } catch {
      return undefined;
    }
  }

  // The newest complete copy per id; stale temp folders are removed.
  private cachedCopies(): Map<string, string> {
    const best = new Map<string, { dir: string; at: number }>();
    const root = this.opts.cacheDir;
    if (!root || !existsSync(root)) return new Map();
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      try {
        if (name.startsWith('.')) {
          if (name.includes('.tmp-') && Date.now() - statSync(dir).mtimeMs > STALE_TMP_MS) rmSync(dir, { recursive: true, force: true });
          continue;
        }
        const meta = this.readMeta(dir);
        if (!meta) continue;
        const at = statSync(join(dir, 'meta.json')).mtimeMs;
        if ((best.get(meta.id)?.at ?? -1) < at) best.set(meta.id, { dir, at });
      } catch {
        // skip unreadable entries
      }
    }
    return new Map([...best].map(([id, v]) => [id, v.dir]));
  }

  private scan(): Source[] {
    const dir = this.opts.sourceDir;
    if (!dir || !existsSync(dir)) return [];
    const out: Source[] = [];
    const used = new Set(['test-pattern']);
    const unique = (base: string) => {
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      if (id !== base) this.engine.log.warn({ base, id }, 'video_id_renamed');
      used.add(id);
      return id;
    };
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory() && existsSync(join(p, 'main.mp4')) && existsSync(join(p, 'sub.mp4'))) {
        out.push({ id: unique(slug(name)), name, kind: 'pair', paths: [join(p, 'main.mp4'), join(p, 'sub.mp4')] });
      } else if (st.isFile() && VIDEO_EXT.has(extname(name).toLowerCase())) {
        const stem = basename(name, extname(name));
        out.push({ id: unique(slug(stem)), name: stem, kind: 'file', paths: [p] });
      }
    }
    return out;
  }

  list(): VideoEntry[] {
    const all = [...this.entries.values()];
    return [all[0], ...all.slice(1).sort((a, b) => a.id.localeCompare(b.id))].map((e) => ({ ...e }));
  }

  selected(): string {
    return this.engine.videoId;
  }

  // null on success, or why not.
  select(id: string): string | null {
    const entry = this.entries.get(id);
    if (!entry) return `unknown video: ${id}`;
    if (entry.state !== 'ready') return `video ${id} is not ready (${entry.state})`;
    const media = this.engine.mediaFor({ video: id });
    try {
      // Loaded now, so missing files fail here and not in a live stream.
      for (const s of ['sub', 'main'] as const) {
        media.liveFlv(s);
        media.clipSize(s);
      }
    } catch (err) {
      return `video ${id} files are missing or unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
    }
    this.engine.setMedia(media, id);
    return null;
  }

  // The video's snapshot, for the picker; undefined unless it is ready.
  async poster(id: string): Promise<Buffer | undefined> {
    if (this.entries.get(id)?.state !== 'ready') return undefined;
    return this.engine.mediaFor({ video: id }).snapshot();
  }

  // Prepares every pending source, one at a time.
  async prepareAll(): Promise<void> {
    for (const s of this.sources.values()) {
      const e = this.entries.get(s.id)!;
      if (this.abort.signal.aborted) return;
      if (e.state !== 'pending') continue;
      e.state = 'preparing';
      this.engine.bus.emit('video', { id: s.id, state: e.state });
      try {
        Object.assign(e, await this.prepare(s), { state: 'ready' as const });
        this.engine.registerMedia(s.id, new FixtureMedia(fixturePaths(this.dirFor(s))));
      } catch (err) {
        if (this.abort.signal.aborted) {
          e.state = 'pending';
          return;
        }
        e.state = 'failed';
        e.error = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').slice(-1)[0].slice(0, 300);
        this.engine.log.warn({ id: s.id, error: e.error }, 'video_prepare_failed');
      }
      this.engine.bus.emit('video', { id: s.id, state: e.state });
    }
  }

  // Stops preparing (the running ffmpeg is killed); used on close.
  stop(): void {
    this.abort.abort();
  }

  private sourceKey(s: Source): string {
    const c = this.engine.config;
    return s.paths.map((p) => `${resolve(p)}:${statSync(p).size}:${statSync(p).mtimeMs}`).join('|') + `|${c.mainSize}|${c.maxVideoS}`;
  }

  // One folder per source version and settings, so instances sharing the
  // cache never overwrite each other's copy.
  private dirFor(s: Source): string {
    return join(this.opts.cacheDir, `${s.id}-${hash(this.sourceKey(s), 10)}`);
  }

  private async prepare(s: Source): Promise<{ converted: boolean; durationS: number }> {
    const dir = this.dirFor(s);
    const key = this.sourceKey(s);
    const cached = this.readMeta(dir);
    if (cached) return { converted: cached.converted, durationS: cached.durationS };
    mkdirSync(this.opts.cacheDir, { recursive: true });
    const tmp = join(this.opts.cacheDir, `.${s.id}.tmp-${randomBytes(4).toString('hex')}`);
    mkdirSync(tmp);
    try {
      const out = fixturePaths(tmp);
      const [w, h] = this.engine.config.mainSize.split('x');
      const limit = ['-t', String(this.engine.config.maxVideoS)];
      const silent = ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono'];
      let converted = true;
      if (s.kind === 'pair') {
        const [m, sub] = await Promise.all(s.paths.map(probe));
        if (m.vcodec === 'hevc' && sub.vcodec === 'h264') {
          converted = false;
          // The camera's own encodings: copied. Audio made AAC if it isn't,
          // and silent when the camera recorded none.
          const audio = (p: typeof m) =>
            p.acodec === 'aac' ? ['-map', '0:v:0', '-map', '0:a:0', '-c:a', 'copy']
              : p.acodec ? ['-map', '0:v:0', '-map', '0:a:0', '-c:a', 'aac', '-ar', '16000']
                : ['-map', '0:v:0', '-map', '1:a:0', '-shortest', '-c:a', 'aac', '-ar', '16000'];
          const extra = (p: typeof m) => (p.acodec ? [] : silent);
          await ffmpeg([...limit, '-i', input(s.paths[0]), ...extra(m), ...audio(m), '-c:v', 'copy', '-tag:v', 'hvc1', ...FRAG, '-f', 'mp4', out.clipMain], this.abort.signal);
          await ffmpeg([...limit, '-i', input(s.paths[1]), ...extra(sub), ...audio(sub), '-c:v', 'copy', ...FRAG, '-f', 'mp4', out.clipSub], this.abort.signal);
        }
      }
      if (converted) {
        const from = [...limit, '-i', input(s.paths[0])];
        const hasAudio = !!(await probe(s.paths[0])).acodec;
        const quiet = hasAudio ? [] : silent;
        const amap = hasAudio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0', '-map', '1:a:0', '-shortest'];
        const fit = (W: string, H: string) => `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
        await ffmpeg([...from, ...quiet, ...amap, '-vf', `${fit(w, h)},fps=20`, '-c:v', 'libx265', '-preset', 'veryfast', '-b:v', '8M',
          '-x265-params', 'keyint=40:min-keyint=40:bframes=0:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '16000', ...FRAG, '-f', 'mp4', out.clipMain], this.abort.signal);
        await ffmpeg([...from, ...quiet, ...amap, '-vf', `${fit('896', '512')},fps=10`, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1M', '-g', '20',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '16000', ...FRAG, '-f', 'mp4', out.clipSub], this.abort.signal);
      }
      // Live FLV: sub as ffmpeg writes it; main as the camera's codec id 12.
      await ffmpeg(['-i', out.clipSub, '-c', 'copy', '-f', 'flv', out.subFlv], this.abort.signal);
      const h265 = join(tmp, 'main.h265');
      const aac = join(tmp, 'main.aac');
      await ffmpeg(['-i', out.clipMain, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', h265], this.abort.signal);
      await ffmpeg(['-i', out.clipMain, '-map', '0:a:0', '-c', 'copy', '-f', 'adts', aac], this.abort.signal);
      const info = await probe(out.clipMain);
      writeFileSync(out.mainFlv, composeMainFlv(readFileSync(h265), readFileSync(aac), Math.round(info.fps) || 20));
      rmSync(h265);
      rmSync(aac);
      await ffmpeg(['-ss', String(Math.min(1, info.duration / 2)), '-i', out.clipMain, '-frames:v', '1', '-q:v', '3', out.snapshot], this.abort.signal);
      writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ version: 'library' }));
      const meta = { version: LIBRARY_VERSION, id: s.id, key, converted, durationS: Math.round(info.duration * 10) / 10 };
      writeFileSync(join(tmp, 'meta.json'), JSON.stringify(meta));
      // The folder is this exact version's; an incomplete one is replaced.
      rmSync(dir, { recursive: true, force: true });
      try {
        renameSync(tmp, dir);
      } catch (err) {
        // Another instance made the same version first: use its copy.
        if (!this.readMeta(dir)) throw err;
      }
      return { converted, durationS: meta.durationS };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
