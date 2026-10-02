// The binary parts of a cmd-8 download, as measured on the RLC-1224A
// (reference/rlc-1224a/baichuan/README.md, "Download").
import type { Moment } from './xml';

// The 32-byte record before the file data in cmd 8's first reply: "1002",
// u32 32, u32 width, u32 height, 0, fps, start and end (y-1900, month, day,
// hour, minute, second), a main/sub flag (1 = main), 0. Not file content.
export function infoRecord(r: { width: number; height: number; fps: number; start: Moment; end: Moment; main: boolean }): Buffer {
  const b = Buffer.alloc(32);
  b.write('1002', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.writeUInt32LE(r.width, 8);
  b.writeUInt32LE(r.height, 12);
  b[16] = 0;
  b[17] = r.fps;
  const put = (at: number, m: Moment) => {
    b[at] = m.year - 1900;
    b[at + 1] = m.month;
    b[at + 2] = m.day;
    b[at + 3] = m.hour;
    b[at + 4] = m.minute;
    b[at + 5] = m.second;
  };
  put(18, r.start);
  put(24, r.end);
  b[30] = r.main ? 1 : 0;
  b[31] = 0;
  return b;
}

// Chunk payloads: 39,400 three times, then 12,872 (one 128 KiB block),
// repeating; the last one is whatever is left.
export const CHUNK_CYCLE = [39_400, 39_400, 39_400, 12_872] as const;

export function chunkSize(index: number, remaining: number): number {
  return Math.min(CHUNK_CYCLE[index % CHUNK_CYCLE.length], remaining);
}

export function chunkSizes(total: number): number[] {
  const out: number[] = [];
  for (let i = 0, left = total; left > 0; i++) {
    const n = chunkSize(i, left);
    out.push(n);
    left -= n;
  }
  return out;
}
