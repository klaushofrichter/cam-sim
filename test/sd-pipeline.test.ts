import { describe, it, expect, afterEach } from 'vitest';
import { makeEngine } from './helpers';
import { SdPipeline } from '../src/pipeline/sd-pipeline';
import { findFonts } from '../src/pipeline/fonts';
import { isKeyframe } from '../src/media/flv-stream';
import type { FlvTag } from '../src/media/flv';

const pipes: SdPipeline[] = [];
afterEach(async () => { while (pipes.length) await pipes.pop()!.stop(); });
const until = async (f: () => boolean, ms = 15_000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 50))) if (f()) return;
  throw new Error('timed out');
};

async function setup(fonts = findFonts()) {
  const e = await makeEngine();
  const p = new SdPipeline(e, { fonts });
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
    for (let i = 0; i < 5; i++) e.bus.emit('settings', { cmd: 'SetOsd' });
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
});
