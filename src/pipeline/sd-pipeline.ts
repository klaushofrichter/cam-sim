import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Engine } from '../engine/engine';
import { timeValue } from '../engine/clock';
import type { FlvTag } from '../media/flv';
import { FlvStreamParser, isConfigTag } from '../media/flv-stream';
import { clockText, filterChain, overlayOf } from './overlay';
import type { LiveSubSource } from './live-sub';

type Fonts = { regular: string; bold: string };

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
  private readonly dir = mkdtempSync(join(tmpdir(), 'cam-sim-pipeline-'));
  private readonly files = { clock: join(this.dir, 'clock.txt'), name: join(this.dir, 'name.txt') };
  private clockTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private lastFailure = 0;
  private stopping = false;
  private expectedExit = false;

  private readonly onSwitch = () => this.follow();
  private readonly onChange = () => {
    if (!this.proc) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.restart(), 500);
    this.debounce.unref?.();
  };

  constructor(private readonly engine: Engine, private readonly opts: { fonts: Fonts | null; rtspUrl?: () => string | undefined; onRunning?: (running: boolean) => void }) {
    engine.liveSub = this;
    for (const t of ['pipeline', 'state', 'fault', 'video'] as const) engine.bus.on(t, this.onSwitch);
    engine.bus.on('settings', this.onChange);
    engine.bus.on('video', this.onChange);
  }

  active(): boolean { return !!this.proc && this.ready; }
  generation(): number { return this.gen; }
  header(): Buffer { return this.hdr; }
  configTags(): FlvTag[] { return this.cfg; }
  subscribe(fn: (t: FlvTag, gen: number) => void): () => void {
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

  private writeClock(): void {
    const e = this.engine;
    const t = timeValue(e.clock, e.config.tz).Time;
    writeFileSync(join(this.dir, 'clock.tmp'), clockText(e.clock.now(), e.config.tz, t));
    renameSync(join(this.dir, 'clock.tmp'), this.files.clock);
  }

  private start(): void {
    const e = this.engine;
    if (!this.opts.fonts) return void e.pipelineOff('no font for the SD pipeline (install font-dejavu or set CAMSIM_FONT_DIR)');
    const running = e.settings.running as { Osd: any; Isp: any };
    writeFileSync(this.files.name, String(running.Osd?.osdChannel?.name ?? ''));
    this.writeClock();
    this.clockTimer = setInterval(() => this.writeClock(), 1000);
    this.clockTimer.unref?.();
    const vf = filterChain(overlayOf(running), this.files, this.opts.fonts);
    const rtsp = this.opts.rtspUrl?.();
    const out = rtsp
      ? ['-f', 'tee', '-map', '0:v', '-map', '0:a?', `[f=rtsp:rtsp_transport=tcp]${rtsp}|[f=flv]pipe:1`]
      : ['-map', '0:v', '-map', '0:a?', '-f', 'flv', 'pipe:1'];
    const args = ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', e.media.clipPath('sub'),
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-r', '10', '-g', '40', '-bf', '0', '-b:v', '1M', '-maxrate', '1M', '-bufsize', '2M', '-c:a', 'copy', ...out];
    const gen = ++this.gen;
    this.ready = false;
    this.cfg = [];
    this.expectedExit = false;
    const parser = new FlvStreamParser();
    parser.on('header', (h: Buffer) => (this.hdr = h));
    parser.on('tag', (t: FlvTag) => {
      if (t.type === 18 || isConfigTag(t)) {
        this.cfg.push(t);
        if (!this.ready && this.cfg.some((c) => c.type === 9)) {
          this.ready = true;
          this.opts.onRunning?.(true);
          e.bus.emit('pipeline', e.pipelineState());
        }
        return;
      }
      for (const fn of this.subs) fn(t, gen);
    });
    let lastErr = '';
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout!.on('data', (d: Buffer) => parser.push(d));
    p.stderr!.on('data', (d) => (lastErr = String(d).trim().split('\n').pop() ?? lastErr));
    p.on('error', (err) => (lastErr = err.message));
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = undefined;
      this.ready = false;
      clearInterval(this.clockTimer);
      this.opts.onRunning?.(false);
      // Decide first, then announce: the announcement re-runs follow(),
      // which must see a pending restart (or the switch already off).
      if (this.expectedExit || this.stopping) {
        e.bus.emit('pipeline', e.pipelineState());
        return void this.follow();
      }
      const now = Date.now();
      if (now - this.lastFailure < 60_000) {
        const msg = (lastErr || 'the SD pipeline stopped').replace(/(?:[A-Za-z]:)?\/[^\s:'"]+/g, '<path>').slice(0, 200);
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

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.debounce);
    clearTimeout(this.restartTimer);
    for (const t of ['pipeline', 'state', 'fault', 'video'] as const) this.engine.bus.off(t, this.onSwitch);
    this.engine.bus.off('settings', this.onChange);
    this.engine.bus.off('video', this.onChange);
    await this.kill();
    clearInterval(this.clockTimer);
    if (this.engine.liveSub === this) this.engine.liveSub = undefined;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
