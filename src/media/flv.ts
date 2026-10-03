// FLV reading and writing, including the Reolink firmware's non-standard
// H.265 in FLV: legacy codec id 12 with the same packet layout as H.264
// (AVCPacketType, 24-bit composition time, 4-byte length-prefixed NAL units)
// and an HEVCDecoderConfigurationRecord as the sequence header.

export interface FlvTag {
  type: 8 | 9 | 18;
  ms: number;
  codecId?: number;
  bytes: Buffer; // tag header, body and trailing PreviousTagSize
}

export function readFlv(buf: Buffer): { header: Buffer; tags: FlvTag[] } {
  const headerEnd = buf.readUInt32BE(5) + 4; // header, then PreviousTagSize0
  const tags: FlvTag[] = [];
  for (let at = headerEnd; at + 11 <= buf.length; ) {
    const size = buf.readUIntBE(at + 1, 3);
    const end = at + 11 + size + 4;
    if (end > buf.length) break;
    const type = buf[at] as FlvTag['type'];
    const ms = buf.readUIntBE(at + 4, 3) + buf[at + 7] * 0x1000000;
    const first = buf[at + 11];
    const codecId = type === 9 ? first & 0x0f : type === 8 ? first >> 4 : undefined;
    tags.push({ type, ms, codecId, bytes: buf.subarray(at, end) });
    at = end;
  }
  return { header: buf.subarray(0, headerEnd), tags };
}

const CODEC_ID = { h264: 7, h265: 12 } as const;
type Codec = keyof typeof CODEC_ID;

function u24(n: number): Buffer {
  const b = Buffer.alloc(3);
  b.writeUIntBE(n & 0xffffff, 0, 3);
  return b;
}

export class FlvWriter {
  header(hasAudio: boolean, hasVideo: boolean): Buffer {
    const b = Buffer.alloc(13);
    b.write('FLV', 0);
    b[3] = 1;
    b[4] = (hasAudio ? 0x04 : 0) | (hasVideo ? 0x01 : 0);
    b.writeUInt32BE(9, 5);
    b.writeUInt32BE(0, 9); // PreviousTagSize0
    return b;
  }

  tag(type: 8 | 9 | 18, ms: number, body: Buffer): Buffer {
    const h = Buffer.alloc(11);
    h[0] = type;
    h.writeUIntBE(body.length, 1, 3);
    h.writeUIntBE(ms & 0xffffff, 4, 3);
    h[7] = (ms >>> 24) & 0xff;
    const prev = Buffer.alloc(4);
    prev.writeUInt32BE(11 + body.length);
    return Buffer.concat([h, body, prev]);
  }

  videoConfig(codec: Codec, record: Buffer, ms: number): Buffer {
    return this.tag(9, ms, Buffer.concat([Buffer.from([(1 << 4) | CODEC_ID[codec], 0]), u24(0), record]));
  }

  video(codec: Codec, nalus: Buffer[], keyframe: boolean, ms: number, ctsMs = 0): Buffer {
    const parts = nalus.flatMap((n) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(n.length);
      return [len, n];
    });
    return this.tag(9, ms, Buffer.concat([Buffer.from([((keyframe ? 1 : 2) << 4) | CODEC_ID[codec], 1]), u24(ctsMs), ...parts]));
  }

  // AAC, 44 kHz/16 bit/stereo flags (0xAF), as FLV requires for AAC.
  audioConfig(asc: Buffer, ms: number): Buffer {
    return this.tag(8, ms, Buffer.concat([Buffer.from([0xaf, 0]), asc]));
  }

  audio(raw: Buffer, ms: number): Buffer {
    return this.tag(8, ms, Buffer.concat([Buffer.from([0xaf, 1]), raw]));
  }
}

export function splitAnnexB(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && buf[end - 1] === 0) end--; // 4-byte start code
        out.push(buf.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < buf.length) out.push(buf.subarray(start));
  return out.filter((n) => n.length > 0);
}

export const h265NalType = (nalu: Buffer) => (nalu[0] >> 1) & 0x3f;

// Removes emulation-prevention bytes (00 00 03 → 00 00).
function unescapeRbsp(b: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
    out.push(b[i]);
  }
  return Buffer.from(out);
}

// HEVCDecoderConfigurationRecord (ISO/IEC 14496-15) for 4:2:0 8-bit video,
// with the profile, tier and level copied from the SPS.
export function hvcc(vps: Buffer, sps: Buffer, pps: Buffer): Buffer {
  const rbsp = unescapeRbsp(sps);
  const ptl = rbsp.subarray(3, 15); // after the 2-byte NAL header and 1 byte of ids
  const head = Buffer.alloc(23);
  head[0] = 1;
  ptl.copy(head, 1, 0, 12); // profile byte, 4 compat, 6 constraint, level
  head.writeUInt16BE(0xf000, 13); // min_spatial_segmentation_idc 0
  head[15] = 0xfc; // parallelismType 0
  head[16] = 0xfc | 1; // chroma 4:2:0
  head[17] = 0xf8; // luma bit depth 8
  head[18] = 0xf8; // chroma bit depth 8
  head.writeUInt16BE(0, 19); // avgFrameRate unspecified
  head[21] = (0 << 6) | (1 << 3) | (1 << 2) | 3; // 1 temporal layer, nested, 4-byte lengths
  head[22] = 3;
  const arrays = [vps, sps, pps].map((n) => {
    const a = Buffer.alloc(5);
    a[0] = 0x80 | h265NalType(n);
    a.writeUInt16BE(1, 1);
    a.writeUInt16BE(n.length, 3);
    return Buffer.concat([a, n]);
  });
  return Buffer.concat([head, ...arrays]);
}

// AVCDecoderConfigurationRecord for one SPS and one PPS.
export function avcc(sps: Buffer, pps: Buffer): Buffer {
  const a = Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]);
  const l1 = Buffer.alloc(2);
  l1.writeUInt16BE(sps.length);
  const l2 = Buffer.alloc(2);
  l2.writeUInt16BE(pps.length);
  return Buffer.concat([a, l1, sps, Buffer.from([1]), l2, pps]);
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Splits an ADTS stream into raw AAC frames and builds the 2-byte
// AudioSpecificConfig from the first header.
export function parseAdts(buf: Buffer): { asc: Buffer; sampleRate: number; frames: Buffer[] } {
  const frames: Buffer[] = [];
  let asc = Buffer.alloc(2);
  let sampleRate = 0;
  for (let at = 0; at + 7 <= buf.length; ) {
    if (buf[at] !== 0xff || (buf[at + 1] & 0xf0) !== 0xf0) throw new Error('not an ADTS stream');
    const protectionAbsent = buf[at + 1] & 1;
    const profile = buf[at + 2] >> 6;
    const freq = (buf[at + 2] >> 2) & 0x0f;
    const chan = ((buf[at + 2] & 1) << 2) | (buf[at + 3] >> 6);
    const len = ((buf[at + 3] & 3) << 11) | (buf[at + 4] << 3) | (buf[at + 5] >> 5);
    const hdr = protectionAbsent ? 7 : 9;
    if (!frames.length) {
      const aot = profile + 1;
      asc = Buffer.alloc(2);
      asc.writeUInt16BE((aot << 11) | (freq << 7) | (chan << 3));
      sampleRate = ADTS_RATES[freq];
    }
    frames.push(buf.subarray(at + hdr, at + len));
    at += len;
  }
  return { asc, sampleRate, frames };
}
