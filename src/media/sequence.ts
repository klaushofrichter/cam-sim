import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { FlvTag } from './flv';
import { isConfigTag, isKeyframe } from './flv-stream';
import type { LiveStream, MediaSource, Stream } from './source';

const isEndOfSequence = (t: FlvTag) => t.type === 9 && t.bytes[12] === 2;

export interface SequenceItem {
  id: string;
  media: MediaSource;
}

// Several compatible videos played one after another, looped, on one clock
// that starts when the sequence is created. The items stay registered.
export class SequenceMedia implements MediaSource {
  private readonly t0: number;
  private readonly now: () => number;
  private readonly listDir: string;
  private readonly flv = new Map<LiveStream, { header: Buffer; tags: FlvTag[] }>();
  private readonly lists = new Map<Stream, string>();

  constructor(private readonly items: SequenceItem[], opts: { now?: () => number; listDir: string }) {
    this.now = opts.now ?? Date.now;
    this.listDir = opts.listDir;
    this.t0 = this.now();
  }

  ids(): string[] {
    return this.items.map((i) => i.id);
  }

  // Where the clock is on the main stream's total length.
  position(now: number = this.now()): { index: number; offsetMs: number } {
    const total = this.durationMs('main');
    let at = total > 0 ? (((now - this.t0) % total) + total) % total : 0;
    for (let index = 0; index < this.items.length; index++) {
      const d = this.items[index].media.durationMs('main');
      if (at < d) return { index, offsetMs: at };
      at -= d;
    }
    return { index: 0, offsetMs: 0 };
  }

  private current(): SequenceItem {
    return this.items[this.position().index];
  }

  currentId(): string {
    return this.current().id;
  }

  liveFlv(stream: LiveStream): { header: Buffer; tags: FlvTag[] } {
    let r = this.flv.get(stream);
    if (!r) {
      const first = this.items[0].media.liveFlv(stream);
      const tags = first.tags.filter((t) => t.type === 18 || isConfigTag(t));
      let offset = 0;
      for (const item of this.items) {
        for (const t of item.media.liveFlv(stream).tags) {
          if (t.type === 18 || isConfigTag(t) || isEndOfSequence(t)) continue;
          tags.push({ ...t, ms: t.ms + offset });
        }
        offset += item.media.durationMs(stream);
      }
      r = { header: first.header, tags };
      this.flv.set(stream, r);
    }
    return r;
  }

  durationMs(stream: LiveStream): number {
    return this.items.reduce((sum, i) => sum + i.media.durationMs(stream), 0);
  }

  startMs(stream: LiveStream): number {
    const total = this.durationMs(stream);
    const at = total > 0 ? (((this.now() - this.t0) % total) + total) % total : 0;
    let start = 0;
    for (const t of this.liveFlv(stream).tags) {
      if (t.type !== 9 || isConfigTag(t) || !isKeyframe(t)) continue;
      if (t.ms > at) break;
      start = t.ms;
    }
    return start;
  }

  snapshot(): Promise<Buffer> {
    return this.current().media.snapshot();
  }

  clipPath(stream: Stream): string {
    return this.current().media.clipPath(stream);
  }

  clipSize(stream: Stream): number {
    return this.current().media.clipSize(stream);
  }

  inputArgs(stream: Stream): string[] {
    let file = this.lists.get(stream);
    if (!file) {
      mkdirSync(this.listDir, { recursive: true });
      file = join(this.listDir, `${stream}.txt`);
      const esc = (p: string) => p.replace(/'/g, "'\\''");
      writeFileSync(file, this.items.map((i) => `file '${esc(i.media.clipPath(stream))}'\n`).join(''));
      this.lists.set(stream, file);
    }
    const sec = (this.position().offsetMs + this.items.slice(0, this.position().index).reduce((s, i) => s + i.media.durationMs(stream), 0)) / 1000;
    return ['-ss', sec.toFixed(3), '-f', 'concat', '-safe', '0', '-i', file];
  }

  // The items stay registered; nothing to release.
  release(): void {}
}
