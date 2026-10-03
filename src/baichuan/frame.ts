// Baichuan framing (the camera's TCP port 9000): the header codec and a
// streaming parser. Written for cam-sim after reolink_aio 5d37cb3
// (baichuan/base_protocol.py L321-L375, util.py) and its PR #186 9a1bb52,
// both MIT (see THIRD_PARTY_NOTICES). Layout and classes as measured on the
// RLC-1224A: reference/rlc-1224a/baichuan/README.md.

const MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);

// Message classes: header bytes 18-19, read big-endian.
export const CLS_NONCE_REQUEST = 0x1465; // client, 20-byte header
export const CLS_NONCE_REPLY = 0x1466; // camera, 20-byte header
export const CLS_CLIENT = 0x1464; // client, 24-byte header
export const CLS_CAMERA = 0x0000; // every other camera reply and push, 24-byte header

// Header bytes 16-17 as u16 LE: a reply's status (200 = c8 00), or the
// nonce exchange's encryption offer (12 dc) and choice (12 dd).
export const ENC_OFFER = 0xdc12;
export const ENC_CHOICE = 0xdd12;

// Byte 12, the channel byte: 250 is the host. It is also the XOR offset.
export const HOST_CHANNEL = 250;

// No client message comes near this; a larger declared length isn't a client.
export const MAX_BODY = 1024 * 1024;

export interface BcHeader {
  cmd: number;
  bodyLen: number; // everything after the header: extension + body
  msgId: number; // bytes 12-15 as u32 LE: the channel byte, then a 24-bit counter
  status: number; // bytes 16-17 as u16 LE
  cls: number;
  payloadOffset: number; // the extension's length (24-byte headers; 0 otherwise)
  size: 20 | 24;
}

export interface BcFrame {
  header: BcHeader;
  ext: Buffer;
  body: Buffer;
}

export class FrameError extends Error {}

export function headerSize(cls: number): 20 | 24 | undefined {
  if (cls === CLS_NONCE_REQUEST || cls === CLS_NONCE_REPLY) return 20;
  if (cls === CLS_CLIENT || cls === CLS_CAMERA) return 24;
  return undefined;
}

export const channelOf = (msgId: number): number => msgId & 0xff;

export function encodeHeader(h: Omit<BcHeader, 'size'>): Buffer {
  const size = headerSize(h.cls);
  if (!size) throw new FrameError(`unknown class ${h.cls.toString(16)}`);
  if (size === 20 && h.payloadOffset) throw new FrameError('a 20-byte header has no extension');
  const b = Buffer.alloc(size);
  MAGIC.copy(b, 0);
  b.writeUInt32LE(h.cmd, 4);
  b.writeUInt32LE(h.bodyLen, 8);
  b.writeUInt32LE(h.msgId >>> 0, 12);
  b.writeUInt16LE(h.status, 16);
  b.writeUInt16BE(h.cls, 18);
  if (size === 24) b.writeUInt32LE(h.payloadOffset, 20);
  return b;
}

export function decodeHeader(b: Buffer): BcHeader {
  if (b.length < 20 || !b.subarray(0, 4).equals(MAGIC)) throw new FrameError('bad magic');
  const cls = b.readUInt16BE(18);
  const size = headerSize(cls);
  if (!size) throw new FrameError(`unknown class ${cls.toString(16)}`);
  if (b.length < size) throw new FrameError('short header');
  return {
    cmd: b.readUInt32LE(4),
    bodyLen: b.readUInt32LE(8),
    msgId: b.readUInt32LE(12),
    status: b.readUInt16LE(16),
    cls,
    payloadOffset: size === 24 ? b.readUInt32LE(20) : 0,
    size,
  };
}

export function encodeFrame(f: { cmd: number; msgId: number; status: number; cls: number; ext?: Buffer; body?: Buffer }): Buffer {
  const ext = f.ext ?? Buffer.alloc(0);
  const body = f.body ?? Buffer.alloc(0);
  const header = encodeHeader({ cmd: f.cmd, bodyLen: ext.length + body.length, msgId: f.msgId, status: f.status, cls: f.cls, payloadOffset: ext.length });
  return Buffer.concat([header, ext, body]);
}

// Messages split across reads, and several in one read. Bad magic, an
// unknown class, an oversized length or an extension past the body throws
// FrameError: the caller closes the connection (there is no resync).
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBody = MAX_BODY) {}

  push(chunk: Buffer): BcFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: BcFrame[] = [];
    for (;;) {
      if (this.buf.length >= 4 && !this.buf.subarray(0, 4).equals(MAGIC)) throw new FrameError('bad magic');
      if (this.buf.length < 20) break;
      const size = headerSize(this.buf.readUInt16BE(18));
      if (!size) throw new FrameError('unknown class');
      if (this.buf.length < size) break;
      const header = decodeHeader(this.buf);
      if (header.bodyLen > this.maxBody) throw new FrameError('body too long');
      if (header.payloadOffset > header.bodyLen) throw new FrameError('extension longer than the body');
      const total = size + header.bodyLen;
      if (this.buf.length < total) break;
      out.push({
        header,
        ext: Buffer.from(this.buf.subarray(size, size + header.payloadOffset)),
        body: Buffer.from(this.buf.subarray(size + header.payloadOffset, total)),
      });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}
