import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FlvWriter, type FlvTag } from '../src/media/flv';
import { inputArgsOf, type LiveStream, type MediaSource, type Stream } from '../src/media/source';
import { FixtureMedia, fixturePaths } from '../src/media/fixtures';
import { SequenceMedia } from '../src/media/sequence';

const w = new FlvWriter();
const tag = (type: 8 | 9 | 18, ms: number, bytes: Buffer): FlvTag => ({ type, ms, bytes });

function fake(id: string, durMs: number, subDurMs = durMs): MediaSource {
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
    durationMs: (s: LiveStream) => (s === 'sub' ? subDurMs : durMs),
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

  it('reads each item\'s durations once, at preload', () => {
    const calls = { flv: 0, dur: 0 };
    const counted = (m: MediaSource): MediaSource => ({
      ...m,
      liveFlv: (s) => (calls.flv++, m.liveFlv(s)),
      durationMs: (s) => (calls.dur++, m.durationMs(s)),
    });
    const c = { t: 0 };
    const s = new SequenceMedia([{ id: 'a', media: counted(a) }, { id: 'b', media: counted(b) }], { now: () => c.t, listDir: dir });
    for (const st of ['sub', 'main'] as const) s.liveFlv(st);
    const after = { ...calls };
    c.t = 1200;
    s.currentId();
    s.position();
    s.durationMs('main');
    s.startMs('sub');
    s.inputArgs('sub');
    expect(calls).toEqual(after);
  });

  it('items lists the videos it plays', () => {
    expect(make({ t: 0 }).items()).toEqual([a, b]);
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

  // The position is an output -ss after the -i: an input -ss on a looped
  // concat makes every later loop's timestamps go backwards (measured,
  // ffmpeg 7.1). The burst reads up to the position without waiting for -re.
  it('inputArgs writes a concat list and starts at the position', () => {
    const c = { t: 0 };
    const s = make(c);
    c.t = 1200;
    const args = s.inputArgs('main');
    const file = args[args.indexOf('-i') + 1];
    expect(file.startsWith(join(dir, 'main-'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(`file '/clips/it'\\''s-a-main.mp4'\nfile '/clips/it'\\''s-b-main.mp4'\n`);
    expect(args).toEqual(['-readrate_initial_burst', '1.200', '-f', 'concat', '-safe', '0', '-i', file, '-ss', '1.200']);
  });

  it('each sequence has its own list files, removed on release', () => {
    const one = make({ t: 0 });
    const two = make({ t: 0 });
    const f1 = one.inputArgs('main').at(-3)!;
    const f2 = two.inputArgs('main').at(-3)!;
    expect(f1).not.toBe(f2);
    expect(one.inputArgs('main').at(-3)).toBe(f1);
    expect(one.inputArgs('sub').at(-3)).not.toBe(f1);
    one.release();
    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(true);
  });

  it('inputArgsOf falls back to -i clipPath', () => {
    const m = new FixtureMedia(fixturePaths(join(tmpdir(), 'camsim-no-fixtures')));
    expect(inputArgsOf(m, 'sub')).toEqual(['-i', m.clipPath('sub')]);
    const s = make({ t: 0 });
    expect(inputArgsOf(s, 'main')).toEqual(s.inputArgs('main'));
  });

  it('startMs past a full loop snaps on the main timeline', () => {
    const c = { t: 0 };
    const s = make(c);
    c.t = 3500 + 600;
    expect(s.startMs('main')).toBe(500);
  });

  it('sub follows the main clock although its durations differ', () => {
    const c = { t: 0 };
    const s = new SequenceMedia([{ id: 'a', media: fake('a', 1000, 950) }, { id: 'b', media: fake('b', 2500, 2450) }], { now: () => c.t, listDir: dir });
    c.t = 3500 * 40 + 1200; // many loops, 200 ms into item b on main
    expect(s.currentId()).toBe('b');
    expect(s.startMs('sub')).toBe(950); // on sub, item b starts after a's 950 ms
    expect(s.inputArgs('sub').at(-1)).toBe('1.150');
    c.t = 3500 * 40 + 970; // item a's sub is over (950) while main is still in a
    expect(s.currentId()).toBe('a');
    expect(s.inputArgs('sub').at(-1)).toBe('0.950');
  });
});
