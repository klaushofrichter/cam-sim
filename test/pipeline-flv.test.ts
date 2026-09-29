import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { makeEngine, listen, login } from './helpers';
import { createCameraApp } from '../src/camera-api/app';
import { SdPipeline } from '../src/pipeline/sd-pipeline';
import { findFonts } from '../src/pipeline/fonts';
import { FlvStreamParser, isKeyframe, isConfigTag } from '../src/media/flv-stream';
import type { FlvTag } from '../src/media/flv';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FLV sub with the SD pipeline', () => {
  it('keeps one client through off → on → off: rising timestamps, each live part starting at a keyframe', async () => {
    const e = await makeEngine();
    const app = createCameraApp(e, { port: 'http' });
    const srv = await listen(app);
    const p = new SdPipeline(e, { fonts: findFonts() });
    cleanups.push(srv.close, () => p.stop());
    const t = await login(app);
    // A tag is live when its payload (everything after the 11-byte header,
    // which holds the rebased timestamp) is one the pipeline sent out.
    const fromPipeline = new Set<string>();
    const offPipe = p.subscribe((t) => fromPipeline.add(t.bytes.subarray(11).toString('base64')));
    cleanups.push(async () => offPipe());
    const received: FlvTag[] = [];
    const parser = new FlvStreamParser();
    parser.on('tag', (tag: FlvTag) => received.push(tag));
    const req = http.get(`${srv.url}/flv?port=1935&app=bcs&stream=channel0_sub.bcs&token=${t}`, (res) => res.on('data', (d: Buffer) => parser.push(d)));
    cleanups.push(async () => void req.destroy());
    await wait(1500);
    e.pipelineOn(5);
    for (let i = 0; i < 150 && !p.active(); i++) await wait(100);
    await wait(6000); // past the next keyframe (every 4 s)
    e.pipelineOff();
    await wait(1500);
    const tags = received.map((tag) => ({ tag, live: fromPipeline.has(tag.bytes.subarray(11).toString('base64')) }));
    const media = tags.filter((x) => x.tag.type === 9 && !isConfigTag(x.tag));
    const ms = media.map((x) => x.tag.ms);
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]);
    const firstLive = media.findIndex((x) => x.live);
    expect(firstLive).toBeGreaterThan(0);
    expect(isKeyframe(media[firstLive].tag)).toBe(true);
    expect(media.slice(-5).every((x) => !x.live)).toBe(true); // back on the loop
  }, 45_000);

  // Final review I4: a connected viewer sees the pipeline within about a second
  // of it running, not a keyframe interval (4 s) later.
  it('switches a connected client to the pipeline without waiting for the next keyframe', async () => {
    const e = await makeEngine();
    const app = createCameraApp(e, { port: 'http' });
    const srv = await listen(app);
    const p = new SdPipeline(e, { fonts: findFonts() });
    cleanups.push(srv.close, () => p.stop());
    const t = await login(app);
    const fromPipeline = new Set<string>();
    const offPipe = p.subscribe((x) => fromPipeline.add(x.bytes.subarray(11).toString('base64')));
    cleanups.push(async () => offPipe());
    let firstLiveAt = 0;
    const parser = new FlvStreamParser();
    parser.on('tag', (tag: FlvTag) => {
      if (!firstLiveAt && tag.type === 9 && fromPipeline.has(tag.bytes.subarray(11).toString('base64'))) firstLiveAt = Date.now();
    });
    const req = http.get(`${srv.url}/flv?port=1935&app=bcs&stream=channel0_sub.bcs&token=${t}`, (res) => res.on('data', (d: Buffer) => parser.push(d)));
    cleanups.push(async () => void req.destroy());
    await wait(1000);
    e.pipelineOn(5);
    for (let i = 0; i < 150 && !p.active(); i++) await wait(50);
    const activeAt = Date.now();
    for (let i = 0; i < 120 && !firstLiveAt; i++) await wait(50);
    expect(firstLiveAt).toBeGreaterThan(0);
    expect(firstLiveAt - activeAt).toBeLessThan(2500);
  }, 45_000);
});
