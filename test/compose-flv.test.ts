import { describe, it, expect } from 'vitest';
import { composeMainFlv } from '../src/media/fixtures';
import { readFlv } from '../src/media/flv';

// Annex B pieces: 4-byte start code + NAL. H.265 NAL header is 2 bytes
// (type << 1); a slice's first byte after the header starts with
// first_slice_segment_in_pic_flag.
const sc = Buffer.from([0, 0, 0, 1]);
const nal = (type: number, first: boolean) => Buffer.from([type << 1, 1, first ? 0x80 : 0x00, 0xaa]);
const vps = Buffer.from([32 << 1, 1, 0x0c]);
const sps = Buffer.from([33 << 1, 1, 0x01, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d, 0xa0]);
const pps = Buffer.from([34 << 1, 1, 0xc1]);
// Minimal ADTS: AAC-LC 16 kHz mono, one 2-byte frame.
const adts = Buffer.from([0xff, 0xf1, 0x60, 0x40, (9 >> 3) & 0xff, ((9 & 7) << 5) | 0x1f, 0xfc, 1, 2]);

describe('composeMainFlv', () => {
  it('splits access units at first slices, with or without AUDs', () => {
    // No AUD NALs (as in a camera's stream copy): an IDR picture in two slices,
    // then two P pictures.
    const stream = Buffer.concat([
      sc, vps, sc, sps, sc, pps,
      sc, nal(19, true), sc, nal(19, false),
      sc, nal(1, true),
      sc, nal(1, true),
    ]);
    const video = readFlv(composeMainFlv(stream, adts, 20)).tags.filter((t) => t.type === 9);
    expect(video).toHaveLength(4); // config + 3 pictures
    expect(video.map((t) => t.bytes[11])).toEqual([0x1c, 0x1c, 0x2c, 0x2c]);
    expect(video.map((t) => t.ms)).toEqual([0, 0, 50, 100]);
  });
});
