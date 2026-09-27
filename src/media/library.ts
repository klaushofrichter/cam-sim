import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { basename, extname, join } from 'path';
import { promisify } from 'util';
import type { Engine } from '../engine/engine';
import { FixtureMedia, composeMainFlv, fixturePaths } from './fixtures';

const run = promisify(execFile);
// Bump when the prepared files change, so caches are rebuilt.
const LIBRARY_VERSION = 1;
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

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';

async function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024, signal });
}

async function probe(file: string): Promise<{ vcodec?: string; acodec?: string; duration: number; fps: number }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate:format=duration', '-of', 'json', file]);
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
    for (const s of this.scan()) {
      this.sources.set(s.id, s);
      this.entries.set(s.id, { id: s.id, name: s.name, state: 'pending' });
    }
  }

  private scan(): Source[] {
    const dir = this.opts.sourceDir;
    if (!dir || !existsSync(dir)) return [];
    const out: Source[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory() && existsSync(join(p, 'main.mp4')) && existsSync(join(p, 'sub.mp4'))) {
        out.push({ id: slug(name), name, kind: 'pair', paths: [join(p, 'main.mp4'), join(p, 'sub.mp4')] });
      } else if (st.isFile() && VIDEO_EXT.has(extname(name).toLowerCase())) {
        out.push({ id: slug(basename(name, extname(name))), name: basename(name, extname(name)), kind: 'file', paths: [p] });
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
    this.engine.setMedia(this.engine.mediaFor({ video: id }), id);
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
        this.engine.registerMedia(s.id, new FixtureMedia(fixturePaths(join(this.opts.cacheDir, s.id))));
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
    return s.paths.map((p) => `${p}:${statSync(p).size}:${statSync(p).mtimeMs}`).join('|') + `|${this.engine.config.mainSize}`;
  }

  private async prepare(s: Source): Promise<{ converted: boolean; durationS: number }> {
    const dir = join(this.opts.cacheDir, s.id);
    const key = this.sourceKey(s);
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      if (meta.version === LIBRARY_VERSION && meta.key === key) return { converted: meta.converted, durationS: meta.durationS };
    } catch {
      // not prepared yet
    }
    mkdirSync(this.opts.cacheDir, { recursive: true });
    const tmp = join(this.opts.cacheDir, `.${s.id}.tmp-${randomBytes(4).toString('hex')}`);
    mkdirSync(tmp);
    try {
      const out = fixturePaths(tmp);
      const [w, h] = this.engine.config.mainSize.split('x');
      let converted = true;
      if (s.kind === 'pair') {
        const [m, sub] = await Promise.all(s.paths.map(probe));
        if (m.vcodec === 'hevc' && sub.vcodec === 'h264') {
          converted = false;
          // The camera's own encodings: copied; audio made AAC if it isn't.
          const audio = (p: typeof m) => (p.acodec === 'aac' ? ['-c:a', 'copy'] : p.acodec ? ['-c:a', 'aac'] : []);
          await ffmpeg(['-i', s.paths[0], '-c:v', 'copy', '-tag:v', 'hvc1', ...audio(m), ...FRAG, '-f', 'mp4', out.clipMain], this.abort.signal);
          await ffmpeg(['-i', s.paths[1], '-c:v', 'copy', ...audio(sub), ...FRAG, '-f', 'mp4', out.clipSub], this.abort.signal);
        }
      }
      if (converted) {
        const input = s.paths[0];
        const hasAudio = !!(await probe(input)).acodec;
        const silent = hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono'];
        const amap = hasAudio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0', '-map', '1:a:0', '-shortest'];
        const fit = (W: string, H: string) => `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
        await ffmpeg(['-i', input, ...silent, ...amap, '-vf', `${fit(w, h)},fps=20`, '-c:v', 'libx265', '-preset', 'veryfast', '-b:v', '8M',
          '-x265-params', 'keyint=40:min-keyint=40:bframes=0:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '16000', ...FRAG, '-f', 'mp4', out.clipMain], this.abort.signal);
        await ffmpeg(['-i', input, ...silent, ...amap, '-vf', `${fit('896', '512')},fps=10`, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1M', '-g', '20',
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
      const meta = { version: LIBRARY_VERSION, key, converted, durationS: Math.round(info.duration * 10) / 10 };
      writeFileSync(join(tmp, 'meta.json'), JSON.stringify(meta));
      rmSync(dir, { recursive: true, force: true });
      try {
        renameSync(tmp, dir);
      } catch (err) {
        // Another instance sharing the cache finished first: use its copy.
        if (!existsSync(join(dir, 'meta.json'))) throw err;
      }
      return { converted, durationS: meta.durationS };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
