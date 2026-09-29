import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { FlvStreamParser, isConfigTag, isKeyframe } from '../src/media/flv-stream';
import { readFlv, type FlvTag } from '../src/media/flv';
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

  it('classifies config tags and keyframes', async () => {
    const paths = await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
    const { tags } = readFlv(readFileSync(paths.subFlv));
    const video = tags.filter((t) => t.type === 9);
    expect(isConfigTag(video[0])).toBe(true); // AVC sequence header first
    expect(isKeyframe(video[1])).toBe(true); // then a keyframe
    expect(video.slice(1).some((t) => !isKeyframe(t))).toBe(true);
  });
});
