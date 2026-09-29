import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Engine } from '../engine/engine';
import { timeValue } from '../engine/clock';
import type { FlvTag } from '../media/flv';
import { FlvStreamParser, isConfigTag, isKeyframe } from '../media/flv-stream';
import { clockText, filterChain, overlayOf } from './overlay';
import type { LiveSubSource } from './live-sub';

type Fonts = { regular: string; bold: string };

// An ffmpeg error line fit for the state and the web UI: the RTSP publisher
// URL (it holds the publisher password) and any file paths removed.
export function scrubError(text: string, rtspUrl?: string): string {
  let t = text;
  if (rtspUrl) {
    t = t.replaceAll(rtspUrl, '<rtsp>');
    const pw = /^rtsp:\/\/[^:]+:([^@]+)@/.exec(rtspUrl)?.[1];
    if (pw) t = t.replaceAll(pw, '***');
  }
  return t.replace(/rtsp:\/\/\S+/g, '<rtsp>').replace(/(?:[A-Za-z]:)?\/[^\s:'"]+/g, '<path>').slice(0, 200);
}

// The optional SD pipeline (spec 2026-09-29): one ffmpeg that re-encodes the
// current video's SD clip with the camera's name, time, watermark and
// flip/mirror, for FLV clients (stdout) and, when given, RTSP (tee).
export class SdPipeline implements LiveSubSource {
  private proc?: ChildProcess;
  private gen = 0;
  private hdr: Buffer = Buffer.alloc(0);
  private cfg: FlvTag[] = [];
  private ready = false;
  private readonly subs = new Set<(t: FlvTag, gen: number) => void>();
  // The tags since the last keyframe: a new subscriber starts from there at
  // once, instead of waiting up to a keyframe interval (4 s).
  private gop: FlvTag[] = [];
  private readonly dir = mkdtempSync(join(tmpdir(), 'cam-sim-pipeline-'));
  private readonly files = { clock: join(this.dir, 'clock.txt'), name: join(this.dir, 'name.txt') };
  private clockTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private lastFailure = 0;
  private stopping = false;
  private expectedExit = false;

  private readonly onSwitch = () => this.follow();
  // Only a switch of video restarts; library preparing/ready events don't.
  private readonly onVideo = (v: { selected?: boolean }) => {
    if (v?.selected) this.onChange();
  };
  private readonly onChange = () => {
    if (!this.proc) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.restart(), 500);
    this.debounce.unref?.();
  };

  constructor(private readonly engine: Engine, private readonly opts: { fonts: Fonts | null; rtspUrl?: () => string | undefined; onProcess?: (up: boolean) => void }) {
    engine.liveSub = this;
    for (const t of ['pipeline', 'state', 'fault', 'video'] as const) engine.bus.on(t, this.onSwitch);
    engine.bus.on('settings', this.onChange);
    engine.bus.on('video', this.onVideo);
  }

  active(): boolean { return !!this.proc && this.ready; }
  generation(): number { return this.gen; }
  header(): Buffer { return this.hdr; }
  configTags(): FlvTag[] { return this.cfg; }
  subscribe(fn: (t: FlvTag, gen: number) => void): () => void {
    for (const t of this.gop) fn(t, this.gen);
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private wanted(): boolean {
    const e = this.engine;
    return e.pipeline.on && e.power === 'on' && !e.rebooting && !e.offline() && !this.stopping;
  }

  private follow(): void {
    if (this.wanted() && !this.proc && !this.restartTimer) this.start();
    else if (!this.wanted() && this.proc) this.kill();
  }

  // Never throws: a removed temp folder is recreated, and anything else
  // (a full disk) is logged, so the simulator can't crash on a clock tick.
  private writeClock(): void {
    const e = this.engine;
    const write = () => {
      const t = timeValue(e.clock, e.config.tz).Time;
      writeFileSync(join(this.dir, 'clock.tmp'), clockText(e.clock.now(), e.config.tz, t));
      renameSync(join(this.dir, 'clock.tmp'), this.files.clock);
    };
    try {
      write();
    } catch {
      try {
        mkdirSync(this.dir, { recursive: true });
        write();
      } catch (err) {
        e.log.warn({ err: (err as Error).message }, 'sd_pipeline_clock_write_failed');
      }
    }
  }

  private start(): void {
    const e = this.engine;
    if (!this.opts.fonts) return void e.pipelineOff('no font for the SD pipeline (install font-dejavu or set CAMSIM_FONT_DIR)');
    const running = e.settings.running as { Osd: any; Isp: any };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.files.name, String(running.Osd?.osdChannel?.name ?? ''));
    this.writeClock();
    this.clockTimer = setInterval(() => this.writeClock(), 1000);
    this.clockTimer.unref?.();
    const vf = filterChain(overlayOf(running), this.files, this.opts.fonts);
    const rtsp = this.opts.rtspUrl?.();
    const out = rtsp
      ? ['-f', 'tee', '-map', '0:v', '-map', '0:a?', `[f=rtsp:rtsp_transport=tcp]${rtsp}|[f=flv]pipe:1`]
      : ['-map', '0:v', '-map', '0:a?', '-f', 'flv', 'pipe:1'];
    const args = ['-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', e.media.clipPath('sub'),
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-r', '10', '-g', '40', '-bf', '0', '-b:v', '1M', '-maxrate', '1M', '-bufsize', '2M', '-c:a', 'aac', '-b:a', '32k', ...out];
    const gen = ++this.gen;
    this.ready = false;
    this.cfg = [];
    this.gop = [];
    this.expectedExit = false;
    const parser = new FlvStreamParser();
    parser.on('header', (h: Buffer) => (this.hdr = h));
    parser.on('tag', (t: FlvTag) => {
      if (t.type === 18 || isConfigTag(t)) {
        this.cfg.push(t);
        if (!this.ready && this.cfg.some((c) => c.type === 9)) {
          this.ready = true;
          e.bus.emit('pipeline', e.pipelineState());
        }
        return;
      }
      if (isKeyframe(t)) this.gop = [];
      if (this.gop.length || isKeyframe(t)) this.gop.push(t);
      for (const fn of this.subs) fn(t, gen);
    });
    let lastErr = '';
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout!.on('data', (d: Buffer) => parser.push(d));
    p.stderr!.on('data', (d) => {
      const text = String(d).trim();
      lastErr = text.split('\n').pop() ?? lastErr;
      e.log.debug({ ffmpeg: rtsp ? text.replaceAll(rtsp, '<rtsp>') : text }, 'sd_pipeline');
    });
    p.on('error', (err) => (lastErr = err.message));
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = undefined;
      this.ready = false;
      clearInterval(this.clockTimer);
      this.opts.onProcess?.(false);
      // Decide first, then announce: the announcement re-runs follow(),
      // which must see a pending restart (or the switch already off).
      if (this.expectedExit || this.stopping) {
        e.bus.emit('pipeline', e.pipelineState());
        return void this.follow();
      }
      const now = Date.now();
      if (now - this.lastFailure < 60_000) {
        const msg = scrubError(lastErr || 'the SD pipeline stopped', rtsp);
        return void e.pipelineOff(msg); // emits 'pipeline'
      }
      this.lastFailure = now;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.follow();
      }, 1000);
      this.restartTimer.unref?.();
      e.bus.emit('pipeline', e.pipelineState());
    });
    this.proc = p;
    // RTSP: the stream copy stands down before this process connects, so
    // neither takes the sub path from the other.
    this.opts.onProcess?.(true);
  }

  private kill(): Promise<void> {
    const p = this.proc;
    if (!p) return Promise.resolve();
    this.expectedExit = true;
    return new Promise((r) => {
      p.once('exit', () => r());
      p.kill('SIGTERM');
      setTimeout(() => p.kill('SIGKILL'), 3000).unref();
    });
  }

  private restart(): void {
    if (!this.proc) return;
    void this.kill(); // the exit handler's follow() starts it again
  }

  // A restart now (RTSP cuts its readers): readers reconnect to the new one.
  restartNow(): void {
    this.restart();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.debounce);
    clearTimeout(this.restartTimer);
    for (const t of ['pipeline', 'state', 'fault', 'video'] as const) this.engine.bus.off(t, this.onSwitch);
    this.engine.bus.off('settings', this.onChange);
    this.engine.bus.off('video', this.onVideo);
    await this.kill();
    clearInterval(this.clockTimer);
    if (this.engine.liveSub === this) this.engine.liveSub = undefined;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
