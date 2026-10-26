import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { FlvStreamParser, isConfigTag, isKeyframe } from '../src/media/flv-stream';
import { FlvWriter, readFlv, type FlvTag } from '../src/media/flv';
import { ensureFixtures, defaultFixtureDir } from '../src/media/fixtures';
import { createLogger } from '../src/log';

describe('FlvStreamParser', () => {
  it('yields the same header and tags as readFlv, whatever the chunking', async () => {
    const paths = await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
    const buf = readFileSync(paths.subFlv);
    const want = readFlv(buf);
    for (const size of [1, 7, 11, 15, 4096, buf.length]) {
      const p = new FlvStreamParser();
      let header: Buffer | undefined;
      const tags: FlvTag[] = [];
      p.on('header', (h: Buffer) => (header = h));
      p.on('tag', (t: FlvTag) => tags.push(t));
      for (let i = 0; i < buf.length; i += size) p.push(buf.subarray(i, i + size));
      expect(header?.equals(want.header)).toBe(true);
      expect(tags.map((t) => [t.type, t.ms, t.bytes.length])).toEqual(want.tags.map((t) => [t.type, t.ms, t.bytes.length]));
    }
  });

  it('emits whole copies: codec ids and timestamps above 24 bits as readFlv, bytes not tied to the chunk', () => {
    const w = new FlvWriter();
    const nalu = Buffer.from([0x26, 0x01, 0xaf, 0x00]);
    const buf = Buffer.concat([w.header(true, true), w.video('h265', [nalu], true, 0x1234567), w.audio(Buffer.from([1, 2, 3]), 0x2000000), w.video('h264', [nalu], false, 5)]);
    const want = readFlv(buf).tags;
    expect(want.map((t) => [t.type, t.codecId, t.ms])).toEqual([[9, 12, 0x1234567], [8, 10, 0x2000000], [9, 7, 5]]);
    const chunk = Buffer.from(buf);
    const tags: FlvTag[] = [];
    const p = new FlvStreamParser();
    p.on('tag', (t: FlvTag) => tags.push(t));
    p.push(chunk);
    chunk.fill(0);
    expect(tags).toEqual(want);
  });

  it('classifies config tags and keyframes', async () => {
    const paths = await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
    const { tags } = readFlv(readFileSync(paths.subFlv));
    const video = tags.filter((t) => t.type === 9);
    expect(isConfigTag(video[0])).toBe(true); // AVC sequence header first
    expect(isKeyframe(video[1])).toBe(true); // then a keyframe
    expect(video.slice(1).some((t) => !isKeyframe(t))).toBe(true);
  });
});
