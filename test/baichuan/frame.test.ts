import { describe, it, expect } from 'vitest';
import {
  CLS_CAMERA, CLS_CLIENT, CLS_NONCE_REPLY, CLS_NONCE_REQUEST, ENC_CHOICE, ENC_OFFER,
  FrameError, FrameParser, decodeHeader, encodeFrame, encodeHeader, headerSize, type BcHeader,
} from '../../src/baichuan/frame';

const hex = (s: string) => Buffer.from(s.replace(/ /g, ''), 'hex');

// Header bytes copied from reference/rlc-1224a/baichuan/ (the file in each line).
const TRACED: Array<{ what: string; h: Omit<BcHeader, 'size'>; bytes: string }> = [
  { what: 'nonce request (login-admin.txt)', h: { cmd: 1, bodyLen: 0, msgId: 0x01fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 00 00 00 00 fa 01 00 00 12 dc 14 65' },
  { what: 'nonce reply (login-admin.txt)', h: { cmd: 1, bodyLen: 311, msgId: 0x01fa, status: ENC_CHOICE, cls: CLS_NONCE_REPLY, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 37 01 00 00 fa 01 00 00 12 dd 14 66' },
  { what: 'login (login-admin.txt)', h: { cmd: 1, bodyLen: 296, msgId: 0x02fa, status: 0, cls: CLS_CLIENT, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 28 01 00 00 fa 02 00 00 00 00 14 64 00 00 00 00' },
  { what: 'login 200 (login-admin.txt)', h: { cmd: 1, bodyLen: 5136, msgId: 0x02fa, status: 200, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 10 14 00 00 fa 02 00 00 c8 00 00 00 00 00 00 00' },
  { what: 'login 401 (err-badpass.txt)', h: { cmd: 1, bodyLen: 130, msgId: 0x02fa, status: 401, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 82 00 00 00 fa 02 00 00 91 01 00 00 00 00 00 00' },
  { what: 'cmd 8 first reply (vod-sub.txt)', h: { cmd: 8, bodyLen: 138, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, payloadOffset: 106 }, bytes: 'f0 de bc 0a 08 00 00 00 8a 00 00 00 fa 07 00 00 c8 00 00 00 6a 00 00 00' },
  { what: 'cmd 8 chunk (vod-sub.txt)', h: { cmd: 8, bodyLen: 39536, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, payloadOffset: 136 }, bytes: 'f0 de bc 0a 08 00 00 00 70 9a 00 00 fa 07 00 00 c8 00 00 00 88 00 00 00' },
  { what: 'cmd 8 not found (err-notfound.txt)', h: { cmd: 8, bodyLen: 0, msgId: 0x04fa, status: 400, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 08 00 00 00 00 00 00 00 fa 04 00 00 90 01 00 00 00 00 00 00' },
  { what: 'push 78 (idle.txt)', h: { cmd: 78, bodyLen: 211, msgId: 0, status: 200, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 4e 00 00 00 d3 00 00 00 00 00 00 00 c8 00 00 00 00 00 00 00' },
  { what: 'unknown cmd 405 (err-protocol.txt)', h: { cmd: 4000, bodyLen: 0, msgId: 0x03fa, status: 405, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a a0 0f 00 00 00 00 00 00 fa 03 00 00 95 01 00 00 00 00 00 00' },
];

describe('Baichuan frame codec', () => {
  it('encodes the traced headers byte for byte and decodes them back', () => {
    for (const t of TRACED) {
      const b = hex(t.bytes);
      expect(encodeHeader(t.h), t.what).toEqual(b);
      expect(decodeHeader(b), t.what).toEqual({ ...t.h, size: b.length });
    }
  });

  it('takes the header size from the class', () => {
    expect(headerSize(CLS_NONCE_REQUEST)).toBe(20);
    expect(headerSize(CLS_NONCE_REPLY)).toBe(20);
    expect(headerSize(CLS_CLIENT)).toBe(24);
    expect(headerSize(CLS_CAMERA)).toBe(24);
    expect(headerSize(0x6482)).toBeUndefined();
  });

  it('encodes a frame as header, extension, body; the length covers both', () => {
    const f = encodeFrame({ cmd: 8, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, ext: Buffer.alloc(106, 1), body: Buffer.alloc(32, 2) });
    expect(f.subarray(0, 24)).toEqual(hex(TRACED[5].bytes));
    expect(f.length).toBe(24 + 138);
  });

  it('refuses an extension on a 20-byte header and an unknown class', () => {
    expect(() => encodeFrame({ cmd: 1, msgId: 0x01fa, status: 0, cls: CLS_NONCE_REQUEST, ext: Buffer.alloc(1) })).toThrow(FrameError);
    expect(() => encodeFrame({ cmd: 1, msgId: 0x01fa, status: 0, cls: 0x6482 })).toThrow(/unknown class/);
  });

  it('parses messages split into single bytes', () => {
    const a = encodeFrame({ cmd: 1, msgId: 0x01fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST });
    const b = encodeFrame({ cmd: 93, msgId: 0x03fa, status: 0, cls: CLS_CLIENT, body: Buffer.from('hello') });
    const p = new FrameParser();
    const out = [];
    for (const byte of Buffer.concat([a, b])) out.push(...p.push(Buffer.from([byte])));
    expect(out.map((f) => [f.header.cmd, f.header.size, f.body.toString()])).toEqual([[1, 20, ''], [93, 24, 'hello']]);
  });

  // The two header sizes (20 and 24 bytes), cut one byte short and one byte over.
  it('parses a header split at 19 and at 23 bytes', () => {
    const nonce = encodeFrame({ cmd: 1, msgId: 0x01fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST });
    const client = encodeFrame({ cmd: 93, msgId: 0x03fa, status: 0, cls: CLS_CLIENT, body: Buffer.from('hello') });
    expect(nonce.length).toBe(20);
    for (const [frame, at, size] of [[nonce, 19, 20], [client, 23, 24]] as const) {
      const p = new FrameParser();
      expect(p.push(frame.subarray(0, at)), `first ${at} bytes`).toEqual([]);
      const out = p.push(frame.subarray(at));
      expect(out, `split at ${at}`).toHaveLength(1);
      expect(out[0].header.size).toBe(size);
      expect(out[0].header.cmd).toBe(frame === nonce ? 1 : 93);
      expect(p.push(Buffer.alloc(0))).toEqual([]);
    }
    // The 20-byte header's last byte is the class's low byte: with 19 bytes
    // present the size is still unknown, and nothing may be decided early.
    const p = new FrameParser();
    expect(p.push(client.subarray(0, 19))).toEqual([]);
    expect(p.push(client.subarray(19, 20))).toEqual([]);
    expect(p.push(client.subarray(20))).toHaveLength(1);
  });

  it('checks the magic as soon as 4 bytes are there, and again for every message in the stream', () => {
    const good = encodeFrame({ cmd: 93, msgId: 0x03fa, status: 0, cls: CLS_CLIENT });
    const p = new FrameParser();
    expect(p.push(Buffer.from([0xaa]))).toEqual([]); // under 4 bytes: waits
    expect(() => p.push(Buffer.from([0xbb, 0xcc, 0xdd]))).toThrow(/bad magic/);
    const q = new FrameParser();
    expect(q.push(good)).toHaveLength(1);
    // Mid-stream: the next message starts with the wrong magic (even one byte off).
    const bad = Buffer.from(good);
    bad[3] ^= 1;
    expect(() => q.push(bad)).toThrow(/bad magic/);
    // A good message and a bad one in one read: the error wins, the caller closes.
    expect(() => new FrameParser().push(Buffer.concat([good, bad]))).toThrow(/bad magic/);
    // A bad message right after a complete one, delivered a byte at a time.
    const r = new FrameParser();
    for (const b of good) r.push(Buffer.from([b]));
    r.push(bad.subarray(0, 3));
    expect(() => r.push(bad.subarray(3))).toThrow(/bad magic/);
  });

  it('parses several messages in one read, extension and body apart', () => {
    const one = encodeFrame({ cmd: 8, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, ext: Buffer.from('EXT'), body: Buffer.from('BODY') });
    const two = encodeFrame({ cmd: 78, msgId: 0, status: 200, cls: CLS_CAMERA, body: Buffer.from('PUSH') });
    const out = new FrameParser().push(Buffer.concat([one, two, one.subarray(0, 10)]));
    expect(out.map((f) => [f.header.cmd, f.ext.toString(), f.body.toString()])).toEqual([[8, 'EXT', 'BODY'], [78, '', 'PUSH']]);
  });

  it('throws on bad magic, an unknown class, an oversized body and an extension past the body', () => {
    expect(() => new FrameParser().push(Buffer.alloc(24))).toThrow(/bad magic/);
    const unknown = encodeFrame({ cmd: 1, msgId: 0x02fa, status: 0, cls: CLS_CLIENT });
    unknown.writeUInt16BE(0x6482, 18);
    expect(() => new FrameParser().push(unknown)).toThrow(/unknown class/);
    // Review Focus 5: a declared length far beyond any client message.
    const big = encodeHeader({ cmd: 1, bodyLen: 0x7fffffff, msgId: 0x02fa, status: 0, cls: CLS_CLIENT, payloadOffset: 0 });
    expect(() => new FrameParser().push(big)).toThrow(/too long/);
    const past = encodeHeader({ cmd: 1, bodyLen: 4, msgId: 0x02fa, status: 0, cls: CLS_CLIENT, payloadOffset: 8 });
    expect(() => new FrameParser().push(past)).toThrow(/extension/);
  });
});
