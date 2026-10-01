import { describe, it, expect, afterEach } from 'vitest';
import { makeEngine } from './helpers';
import { SdPipeline, scrubError } from '../src/pipeline/sd-pipeline';
import { findFonts } from '../src/pipeline/fonts';
import { isKeyframe } from '../src/media/flv-stream';
import { existsSync, readFileSync } from 'fs';
import type { FlvTag } from '../src/media/flv';

const pipes: SdPipeline[] = [];
afterEach(async () => { while (pipes.length) await pipes.pop()!.stop(); });
const until = async (f: () => boolean, ms = 15_000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 50))) if (f()) return;
  throw new Error('timed out');
};

async function setup(fonts = findFonts(), opts: Partial<ConstructorParameters<typeof SdPipeline>[1]> = {}) {
  const e = await makeEngine();
  const p = new SdPipeline(e, { fonts, ...opts });
  pipes.push(p);
  return { e, p };
}

describe('SdPipeline', () => {
  it('runs only while switched on, streams H.264 896×512 FLV with config tags, then keyframes', async () => {
    const { e, p } = await setup();
    expect(p.active()).toBe(false);
    e.pipelineOn(5);
    await until(() => p.active());
    const cfg = p.configTags();
    expect(cfg.some((t) => t.type === 9 && t.codecId === 7)).toBe(true); // AVC sequence header
    const tags: FlvTag[] = [];
    const off = p.subscribe((t) => tags.push(t));
    await until(() => tags.filter((t) => t.type === 9).length > 45); // a keyframe every 40 frames
    off();
    expect(tags.some(isKeyframe)).toBe(true);
    expect(e.pipelineState()).toMatchObject({ on: true, running: true });
    e.pipelineOff();
    await until(() => !p.active());
  }, 30_000);

  it('restarts once for a burst of settings changes (review focus 2), with a new generation', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    const g = p.generation();
    const osd = (e.settings.running as unknown as { Osd: { watermark: number } }).Osd;
    for (let i = 0; i < 5; i++) {
      osd.watermark = osd.watermark ? 0 : 1;
      e.bus.emit('settings', { cmd: 'SetOsd' });
    }
    await until(() => p.generation() === g + 1 && p.active());
    await new Promise((r) => setTimeout(r, 1500));
    expect(p.generation()).toBe(g + 1);
  }, 30_000);

  it('stops while powered off and resumes on power-on with time left (review focus 3)', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    e.powerOff();
    await until(() => !p.active());
    expect(e.pipelineState()).toMatchObject({ on: true, running: false });
    await e.powerOn(0);
    await until(() => p.active());
  }, 30_000);

  it('switches off with an error when there is no font', async () => {
    const { e } = await setup(null);
    e.pipelineOn(5);
    await until(() => !e.pipeline.on);
    expect(e.pipelineState()).toEqual({ on: false, error: expect.stringMatching(/font/) });
  });

  it('switches off with an error after a second failure within a minute, not restarting at once', async () => {
    const { e, p } = await setup();
    const clip = '/nonexistent/clip-sub.mp4';
    const media = e.media;
    e.media = { ...media, clipPath: () => clip } as typeof media; // ffmpeg can't open its input
    const starts: number[] = [];
    const g0 = p.generation();
    e.bus.on('pipeline', () => starts.push(p.generation()));
    const t0 = Date.now();
    e.pipelineOn(5);
    await until(() => !e.pipeline.on, 20_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000); // one restart, after 1 s
    expect(p.generation() - g0).toBe(2); // started twice, then off
    expect(e.pipeline.error).toBeTruthy();
    expect(e.pipeline.error).not.toContain('/nonexistent'); // paths removed
    e.media = media;
  }, 30_000);

  // Final review I3: library preparing/ready events aren't a video switch.
  it('restarts for a selected video only, not for library progress events', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    const g = p.generation();
    e.bus.emit('video', { id: 'garden', state: 'preparing' });
    e.bus.emit('video', { id: 'garden', state: 'ready' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(p.generation()).toBe(g);
    e.bus.emit('video', { id: 'garden', selected: true });
    await until(() => p.generation() === g + 1 && p.active());
  }, 30_000);

  // Final review I4: a late subscriber starts at once, with the GOP since the last keyframe.
  it('hands a new subscriber the frames since the last keyframe, keyframe first', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    await new Promise((r) => setTimeout(r, 1500)); // mid-GOP (keyframes every 4 s)
    const got: FlvTag[] = [];
    const off = p.subscribe((t) => got.push(t));
    await new Promise((r) => setTimeout(r, 150));
    off();
    const video = got.filter((t) => t.type === 9);
    expect(video.length).toBeGreaterThan(5); // replayed, not waiting for the next keyframe
    expect(isKeyframe(video[0])).toBe(true);
  }, 30_000);

  // Final review I5: the RTSP publisher password never reaches the state.
  it('scrubs paths and the RTSP URL (with its password) from an error line', () => {
    const url = 'rtsp://camsim-publisher:0123abcd@127.0.0.1:8554/h264Preview_01_sub';
    const msg = scrubError(`[out#0/tee @ 0x1] ${url}: Connection refused; also /tmp/x/clock.txt`, url);
    expect(msg).not.toContain('0123abcd');
    expect(msg).not.toContain('/tmp/x');
    expect(msg).toContain('Connection refused');
  });

  // Final review minor 5, re-graded Important (a crash of the whole simulator):
  // the clock writer survives its temp folder being removed.
  it('keeps running when its temp folder disappears (no uncaught error)', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    const dir = (p as unknown as { dir: string }).dir;
    const { rmSync, existsSync } = await import('fs');
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 2500));
    expect(existsSync(`${dir}/clock.txt`)).toBe(true); // recreated
    expect(e.pipeline.on).toBe(true);
  }, 30_000);

  // Issue #46 from here on.
  it('restarts for a changed filter chain only; a new name is written to its file', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    const g = p.generation();
    e.bus.emit('settings', { cmd: 'SetRec' });
    e.bus.emit('settings', { cmd: 'SetFtp' });
    const ch = (e.settings.running as unknown as { Osd: { osdChannel: { name: string } } }).Osd.osdChannel;
    ch.name = 'Renamed';
    e.bus.emit('settings', { cmd: 'SetOsd' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(p.generation()).toBe(g);
    const dir = (p as unknown as { dir: string }).dir;
    expect(readFileSync(`${dir}/name.txt`, 'utf8')).toBe('Renamed');
    const isp = (e.settings.running as unknown as { Isp: { mirroring: number } }).Isp;
    isp.mirroring = isp.mirroring ? 0 : 1;
    e.bus.emit('settings', { cmd: 'SetIsp' });
    await until(() => p.generation() === g + 1 && p.active());
  }, 30_000);

  it('treats a failed spawn (no exit event) as a failure, and stop() still returns', async () => {
    const { e, p } = await setup(findFonts(), { ffmpeg: '/nonexistent/ffmpeg' });
    const g0 = p.generation();
    e.pipelineOn(5);
    await until(() => !e.pipeline.on, 10_000);
    expect(p.generation() - g0).toBe(2);
    expect(e.pipeline.error).toBeTruthy();
    expect(e.pipeline.error).not.toContain('/nonexistent');
    const t = Date.now();
    await pipes.pop()!.stop();
    expect(Date.now() - t).toBeLessThan(1000);
  }, 30_000);

  it('gives a new switch-on its own restart, whatever failed in the run before', async () => {
    const { e, p } = await setup(findFonts(), { ffmpeg: '/nonexistent/ffmpeg' });
    e.pipelineOn(5);
    await until(() => !e.pipeline.on, 10_000);
    const g = p.generation();
    e.pipelineOn(5);
    await until(() => !e.pipeline.on, 10_000);
    expect(p.generation() - g).toBe(2); // restarted once again, not off at the first failure
  }, 30_000);

  it('makes its temp folder only when it starts', async () => {
    const { e, p } = await setup();
    expect((p as unknown as { dir?: string }).dir).toBeUndefined();
    e.pipelineOn(5);
    await until(() => p.active());
    expect(existsSync((p as unknown as { dir: string }).dir)).toBe(true);
  }, 30_000);

  it('announces states in order: the switch-on before a refusal (no font)', async () => {
    const { e } = await setup(null);
    const seen: Array<{ on: boolean }> = [];
    e.bus.on('pipeline', (s) => seen.push(s)); // after the pipeline's own listener, like SSE
    e.pipelineOn(5);
    await until(() => !e.pipeline.on);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((s) => s.on)).toEqual([true, false]);
  });

  it('gives up when its RTSP output fails, instead of carrying on with FLV only', async () => {
    const url = 'rtsp://camsim-publisher:pw0123@127.0.0.1:1/h264Preview_01_sub'; // nothing listens
    const { e } = await setup(findFonts(), { rtspUrl: () => url });
    e.pipelineOn(5);
    await until(() => !e.pipeline.on, 20_000);
    expect(e.pipeline.error).toBeTruthy();
    expect(e.pipeline.error).not.toContain('pw0123');
  }, 30_000);

  it('hands the RTSP sub path back on a switch-off, but not while closing', async () => {
    const calls: boolean[] = [];
    const { e, p } = await setup(findFonts(), { onProcess: (up) => calls.push(up) });
    e.pipelineOn(5);
    await until(() => p.active());
    e.pipelineOff();
    await until(() => calls.length === 2);
    expect(calls).toEqual([true, false]);
    e.pipelineOn(5);
    await until(() => p.active());
    await pipes.pop()!.stop();
    expect(calls).toEqual([true, false, true]);
  }, 30_000);
});
