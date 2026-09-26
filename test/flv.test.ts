import { describe, it, expect } from 'vitest';
import { FlvWriter, readFlv, hvcc, avcc, splitAnnexB, h265NalType, parseAdts } from '../src/media/flv';

// Minimal NAL units: 2-byte H.265 header (type << 1), then payload.
const nal = (type: number, payload: number[]) => Buffer.from([type << 1, 1, ...payload]);
// SPS: vps id/max_sub_layers/nesting byte, then profile_tier_level (12 bytes).
const VPS = nal(32, [0x0c, 0x01]);
const SPS = nal(33, [0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d, 0xa0]);
const PPS = nal(34, [0xc1, 0x73]);
const IDR = nal(19, [0xaf, 0xfe]);

describe('Annex B helpers', () => {
  it('splits start-code separated NAL units', () => {
    const buf = Buffer.concat([Buffer.from([0, 0, 0, 1]), VPS, Buffer.from([0, 0, 1]), SPS]);
    const parts = splitAnnexB(buf);
    expect(parts.map(h265NalType)).toEqual([32, 33]);
    expect(parts[1]).toEqual(SPS);
  });
});

describe('hvcc', () => {
  it('builds an HEVCDecoderConfigurationRecord', () => {
    const r = hvcc(VPS, SPS, PPS);
    expect(r[0]).toBe(1); // configurationVersion
    expect(r[1]).toBe(0x01); // profile space/tier/idc from the SPS
    expect(r[12]).toBe(0x5d); // level
    expect(r[21] & 0x03).toBe(3); // lengthSizeMinusOne
    expect(r[22]).toBe(3); // numOfArrays
    let at = 23;
    const types: number[] = [];
    for (let i = 0; i < 3; i++) {
      types.push(r[at] & 0x3f);
      const len = r.readUInt16BE(at + 3);
      at += 5 + len;
    }
    expect(types).toEqual([32, 33, 34]);
    expect(at).toBe(r.length);
  });
});

describe('FlvWriter', () => {
  it('writes H.265 with the legacy codec id 12, readable back', () => {
    const w = new FlvWriter();
    const buf = Buffer.concat([
      w.header(false, true),
      w.videoConfig('h265', hvcc(VPS, SPS, PPS), 0),
      w.video('h265', [IDR], true, 0),
      w.video('h265', [nal(1, [1])], false, 50),
    ]);
    const { header, tags } = readFlv(buf);
    expect(header.subarray(0, 3).toString()).toBe('FLV');
    expect(header[4]).toBe(0x01);
    expect(tags.map((t) => [t.type, t.ms, t.codecId])).toEqual([[9, 0, 12], [9, 0, 12], [9, 50, 12]]);
    const body = (i: number) => tags[i].bytes.subarray(11);
    expect(body(0)[0]).toBe(0x1c); // keyframe, codec 12
    expect(body(0)[1]).toBe(0); // sequence header
    expect(body(1)[0]).toBe(0x1c);
    expect(body(1)[1]).toBe(1); // NALU
    expect(body(1).readUInt32BE(5)).toBe(IDR.length);
    expect(body(2)[0]).toBe(0x2c); // inter frame
    // PreviousTagSize trails each tag
    expect(tags[0].bytes.readUInt32BE(tags[0].bytes.length - 4)).toBe(tags[0].bytes.length - 4);
  });

  it('writes H.264 (codec id 7) and AAC', () => {
    const w = new FlvWriter();
    const sps = Buffer.from([0x67, 0x64, 0x00, 0x1f, 0xac]);
    const pps = Buffer.from([0x68, 0xee, 0x3c, 0x80]);
    const buf = Buffer.concat([
      w.header(true, true),
      w.videoConfig('h264', avcc(sps, pps), 0),
      w.audioConfig(Buffer.from([0x14, 0x08]), 0),
      w.audio(Buffer.from([1, 2, 3]), 64),
    ]);
    const { header, tags } = readFlv(buf);
    expect(header[4]).toBe(0x05);
    expect(tags.map((t) => [t.type, t.codecId])).toEqual([[9, 7], [8, 10], [8, 10]]);
    expect(tags[1].bytes[11]).toBe(0xaf);
    expect(tags[0].bytes.subarray(16, 20)).toEqual(Buffer.from([1, 0x64, 0x00, 0x1f]));
    expect(tags[2].ms).toBe(64);
  });

  it('keeps timestamps above 24 bits', () => {
    const w = new FlvWriter();
    const { tags } = readFlv(Buffer.concat([w.header(true, false), w.audio(Buffer.from([1]), 0x1234567)]));
    expect(tags[0].ms).toBe(0x1234567);
  });
});

describe('parseAdts', () => {
  it('splits ADTS frames and derives the AudioSpecificConfig', () => {
    // AAC-LC, 16 kHz (index 8), mono, frame length 7 + 2
    const hdr = (len: number) => Buffer.from([0xff, 0xf1, 0x60, 0x40, (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
    const buf = Buffer.concat([hdr(9), Buffer.from([1, 2]), hdr(8), Buffer.from([3])]);
    const { asc, sampleRate, frames } = parseAdts(buf);
    expect(sampleRate).toBe(16000);
    expect(asc).toEqual(Buffer.from([0x14, 0x08]));
    expect(frames).toEqual([Buffer.from([1, 2]), Buffer.from([3])]);
  });
});
