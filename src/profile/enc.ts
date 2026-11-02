// GetEnc's range (action 1) and SetEnc's checks. The range is a list of
// entries, each one main size paired with one sub size, and per stream the
// codecs, frame rates, bit rates, profiles and GOP the camera offers with
// that size (as the E1 Outdoor Pro answers, reference/E1-Outdoor-Pro/GetEnc.json).
import e1Range from './e1-enc-range.json';
import rlcRange from './rlc-enc-range.json';
import cx820Range from './cx820-enc-range.json';

type Obj = Record<string, any>;

export interface EncStream {
  bitRate: number;
  frameRate: number;
  gop: number;
  height: number;
  profile: string;
  size: string;
  vType: string;
  width: number;
}
export interface Enc { audio: number; channel: number; mainStream: EncStream; subStream: EncStream }

export const STREAM_KEYS = ['mainStream', 'subStream'] as const;
export type StreamKey = (typeof STREAM_KEYS)[number];

// The E1 Outdoor Pro's range, measured 2026-10-30.
export const E1_ENC_RANGE: Obj[] = e1Range;
// The RLC-1224A's and CX820's, measured 2026-11-02 through cam-proxy's
// GET /settings/encoding (reference/<model>/GetEnc-range-proxy.json): its
// options in the camera's form. That answer carries no per-entry `default`,
// so these entries have none (the E1's capture does).
export const RLC_ENC_RANGE: Obj[] = rlcRange;
export const CX820_ENC_RANGE: Obj[] = cx820Range;

// "W*H" as numbers, or undefined.
export function sizeOf(size: unknown): { width: number; height: number } | undefined {
  const m = typeof size === 'string' ? /^(\d{2,5})\*(\d{2,5})$/.exec(size) : null;
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

const has = (list: unknown, v: unknown) => Array.isArray(list) && list.includes(v);

// Whether `enc` (a whole Enc object) is one the range allows: the main and
// sub sizes are one entry's pair, and each stream's codec, frame rate, bit
// rate, profile and GOP are in that entry's lists. The camera's answer to a
// value out of range was not measured: -4 "param error", as for other Sets.
export function encRspCode(range: Obj[], enc: Obj): number | null {
  const main = enc?.mainStream, sub = enc?.subStream;
  if (!main || !sub) return -4;
  const entry = range.find((e) => e.mainStream?.size === main.size && e.subStream?.size === sub.size);
  if (!entry) return -4;
  for (const k of STREAM_KEYS) {
    const s = enc[k], r = entry[k];
    if (!has(r.vType, s.vType) || !has(r.frameRate, s.frameRate) || !has(r.bitRate, s.bitRate) || !has(r.profile, s.profile)) return -4;
    if (!Number.isInteger(s.gop) || s.gop < r.gop.min || s.gop > r.gop.max) return -4;
  }
  return null;
}

// width and height follow size (the camera reports both; SetEnc carries the
// size string, so a stale width or height in a whole-object Set is not kept).
export function withSizes(enc: Obj): Obj {
  for (const k of STREAM_KEYS) {
    const s = enc[k];
    const wh = s && sizeOf(s.size);
    if (wh) Object.assign(s, wh);
  }
  return enc;
}
