import { EventEmitter } from 'events';
import { parseTagAt, type FlvTag } from './flv';

// AVC/HEVC or AAC sequence header (packet type 0).
export const isConfigTag = (t: FlvTag) => (t.type === 9 || t.type === 8) && t.bytes[12] === 0;
// A video keyframe (frame type 1 in the tag body's first byte).
export const isKeyframe = (t: FlvTag) => t.type === 9 && t.bytes[11] >> 4 === 1;

// FLV from a pipe (ffmpeg -f flv pipe:1): the header once, then whole tags
// as they complete, whatever the chunk boundaries.
export class FlvStreamParser extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private headerDone = false;

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.headerDone) {
      if (this.buf.length < 9) return;
      const end = this.buf.readUInt32BE(5) + 4; // header, then PreviousTagSize0
      if (this.buf.length < end) return;
      this.emit('header', Buffer.from(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end);
      this.headerDone = true;
    }
    let at = 0;
    for (let t; (t = parseTagAt(this.buf, at)); at = t.end) {
      // A copy: the buffer's memory is kept for the next chunk.
      this.emit('tag', { ...t.tag, bytes: Buffer.from(t.tag.bytes) } satisfies FlvTag);
    }
    this.buf = this.buf.subarray(at);
  }
}
