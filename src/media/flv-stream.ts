import { EventEmitter } from 'events';
import type { FlvTag } from './flv';

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
    while (at + 11 <= this.buf.length) {
      const size = this.buf.readUIntBE(at + 1, 3);
      const end = at + 11 + size + 4;
      if (end > this.buf.length) break;
      const bytes = Buffer.from(this.buf.subarray(at, end));
      const type = bytes[0] as FlvTag['type'];
      const ms = bytes.readUIntBE(4, 3) + bytes[7] * 0x1000000;
      const first = bytes[11];
      const codecId = type === 9 ? first & 0x0f : type === 8 ? first >> 4 : undefined;
      this.emit('tag', { type, ms, codecId, bytes } satisfies FlvTag);
      at = end;
    }
    this.buf = this.buf.subarray(at);
  }
}
