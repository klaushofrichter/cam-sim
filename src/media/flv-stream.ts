import { EventEmitter } from 'events';
import { parseTagAt, type FlvTag } from './flv';

// AVC/HEVC or AAC sequence header (packet type 0).
export const isConfigTag = (t: FlvTag) => (t.type === 9 || t.type === 8) && t.bytes[12] === 0;
// A video keyframe (frame type 1 in the tag body's first byte).
export const isKeyframe = (t: FlvTag) => t.type === 9 && t.bytes[11] >> 4 === 1;

// FLV from a pipe (ffmpeg -f flv pipe:1): the header once, then whole tags
// as they complete, whatever the chunk boundaries. Chunks are queued and joined
// only once the next header or tag is complete, so small chunks cost linear
// time (joining on every chunk was quadratic in the tag size).
export class FlvStreamParser extends EventEmitter {
  private chunks: Buffer[] = [];
  private queued = 0;
  private need = 9; // bytes until the next header or tag can be parsed
  private headerDone = false;

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.queued += chunk.length;
    if (this.queued < this.need) return;
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.queued);
    if (!this.headerDone) {
      const end = buf.readUInt32BE(5) + 4; // header, then PreviousTagSize0
      if (buf.length < end) return this.keep(buf, end);
      this.emit('header', Buffer.from(buf.subarray(0, end)));
      buf = buf.subarray(end);
      this.headerDone = true;
    }
    let at = 0;
    for (let t; (t = parseTagAt(buf, at)); at = t.end) {
      // A copy: the buffer's memory is kept for the next chunk.
      this.emit('tag', { ...t.tag, bytes: Buffer.from(t.tag.bytes) } satisfies FlvTag);
    }
    const rest = buf.subarray(at);
    this.keep(rest, rest.length >= 4 ? 11 + rest.readUIntBE(1, 3) + 4 : 11);
  }

  private keep(rest: Buffer, need: number): void {
    this.chunks = rest.length ? [rest] : [];
    this.queued = rest.length;
    this.need = need;
  }
}
