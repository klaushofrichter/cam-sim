import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FlvWriter, type FlvTag } from '../src/media/flv';
import type { LiveStream, MediaSource, Stream } from '../src/media/source';
import { SequenceMedia } from '../src/media/sequence';

const w = new FlvWriter();
const tag = (type: 8 | 9 | 18, ms: number, bytes: Buffer): FlvTag => ({ type, ms, bytes });

function fake(id: string, durMs: number): MediaSource {
  const header = w.header(false, true);
  const tags: FlvTag[] = [
    tag(18, 0, w.tag(18, 0, Buffer.from([2, 0, 0]))),
    tag(9, 0, w.videoConfig('h264', Buffer.from([1, 2, 3]), 0)),
  ];
  for (let ms = 0; ms < durMs; ms += 50) {
    tags.push(tag(9, ms, w.video('h264', [Buffer.from([ms & 0xff])], ms % 500 === 0, ms)));
  }
  tags.push(tag(9, durMs, w.tag(9, durMs, Buffer.from([0x17, 2, 0, 0, 0]))));
  return {
    snapshot: async () => Buffer.from(id),
    liveFlv: (_s: LiveStream) => ({ header, tags }),
    durationMs: () => durMs,
    clipPath: (s: Stream) => `/clips/it's-${id}-${s}.mp4`,
    clipSize: () => id.length,
  };
}

describe('SequenceMedia', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'seq-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const a = fake('a', 1000);
  const b = fake('b', 2500);
  const make = (clock: { t: number }) => new SequenceMedia([{ id: 'a', media: a }, { id: 'b', media: b }], { now: () => clock.t, listDir: dir });

  it('chains tags with continuing timestamps and one config tag', () => {
    const { tags } = make({ t: 0 }).liveFlv('main');
    const video = tags.filter((t) => t.type === 9 && t.bytes[12] === 1);
    for (let i = 1; i < video.length; i++) expect(video[i].ms).toBeGreaterThan(video[i - 1].ms);
    expect(tags.filter((t) => t.type === 9 && t.bytes[12] === 0)).toHaveLength(1);
    expect(tags.filter((t) => t.bytes[12] === 2)).toHaveLength(0);
    const second = video.find((t) => t.ms >= 1000)!;
    expect(second.ms).toBe(1000);
    expect(second.bytes).toBe(b.liveFlv('main').tags[2].bytes);
    expect(video[0].bytes).toBe(a.liveFlv('main').tags[2].bytes);
  });

  it('durationMs is the sum', () => {
    expect(make({ t: 0 }).durationMs('main')).toBe(3500);
  });

  it('position follows the clock across items of different length', () => {
    const c = { t: 10_000 };
    const s = make(c);
    expect(s.position(11_200)).toEqual({ index: 1, offsetMs: 200 });
    expect(s.position(13_600)).toEqual({ index: 0, offsetMs: 100 });
  });

  it('startMs snaps to the last keyframe at or before the clock', () => {
    const c = { t: 5000 };
    const s = make(c);
    expect(s.startMs('main')).toBe(0);
    c.t = 5000 + 740;
    expect(s.startMs('main')).toBe(500);
    c.t = 5000 + 1230; // item b, 230 ms in; keyframes every 500 ms from 1000
    expect(s.startMs('main')).toBe(1000);
    c.t = 5000 + 1600;
    expect(s.startMs('main')).toBe(1500);
  });

  it('currentId, snapshot and clipPath follow the playing item', async () => {
    const c = { t: 0 };
    const s = make(c);
    expect(s.ids()).toEqual(['a', 'b']);
    expect(s.currentId()).toBe('a');
    c.t = 1200;
    expect(s.currentId()).toBe('b');
    expect((await s.snapshot()).toString()).toBe('b');
    expect(s.clipPath('main')).toBe(b.clipPath('main'));
    expect(s.clipSize('main')).toBe(1);
  });

  it('inputArgs writes a concat list and seeks to the position', () => {
    const c = { t: 0 };
    const s = make(c);
    c.t = 1200;
    const args = s.inputArgs('main');
    const file = join(dir, 'main.txt');
    expect(readFileSync(file, 'utf8')).toBe(`file '/clips/it'\\''s-a-main.mp4'\nfile '/clips/it'\\''s-b-main.mp4'\n`);
    expect(args).toEqual(['-ss', '1.200', '-f', 'concat', '-safe', '0', '-i', file]);
  });
});
