// Recordings over Baichuan: the file behind an <Id>, cmd 13's file info, and
// a cmd-8 transfer (the info record, then the chunks), as measured on the
// RLC-1224A (reference/rlc-1224a/baichuan/: vod-*.txt, fileinfo.txt,
// abort.txt). After PR #186 9a1bb52 to reolink_aio (MIT, THIRD_PARTY_NOTICES).
import { open } from 'fs/promises';
import type { Engine } from '../engine/engine';
import type { Recording, Stream } from '../engine/sdcard';
import { ENC } from '../profile/rlc1224a';
import { CLS_CAMERA, encodeFrame } from './frame';
import { aesEncrypt, encryptChunk } from './cipher';
import { ENCRYPT_LEN, EXT_BINARY, EXT_CHUNK, fileInfoXml, type Moment } from './xml';
import { chunkSize, infoRecord } from './records';
import type { TransferLike } from './server';

// Measured: about 400 KB (13 frames) still arrive after cmd 9 (abort.txt).
export const FRAMES_AFTER_STOP = 13;
// Measured: a cmd 8 without cmd 9 lets the running transfer finish its
// current 128 KiB block and two more (8 chunks from a block boundary) before
// the new file starts (err-second-download.txt (A): 393216 B under the old id).
export const BLOCKS_AFTER_REPLACE = 2;
const CHUNKS_PER_BLOCK = 4; // CHUNK_CYCLE: 3 × 39,400 + 12,872 = 128 KiB
// The first cmd-8 reply's body: the 106-byte extension and the 32-byte record.
export const FIRST_REPLY_LEN = Buffer.byteLength(EXT_BINARY) + 32;

export interface BcFile {
  path: string;
  size: number; // the stored size: the one in the name and in cmd 13; cmd 8 sends exactly this
  mediaSize: number; // the media file's actual size (may differ, see resolveFile)
  stream: Stream;
  start: Moment;
  end: Moment;
}

const moment = (date: string, hms: string): Moment => ({
  year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)),
  hour: Number(hms.slice(0, 2)), minute: Number(hms.slice(2, 4)), second: Number(hms.slice(4, 6)),
});

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Camera-local start and end; a clip across midnight ends the next day.
export function timesOf(rec: Recording, stream: Stream): { start: Moment; end: Moment } {
  const end = (stream === 'main' ? (rec.mainEnd ?? rec.end) : rec.end) ?? rec.start;
  return { start: moment(rec.date, rec.start), end: moment(end < rec.start ? nextDay(rec.date) : rec.date, end) };
}

// Recordings whose size mismatch was logged, per engine (once per recording).
const warned = new WeakMap<Engine, Set<string>>();

// The file behind cmd 8's <Id>: exactly a name that HTTP Search lists.
// Its size is the STORED one (the name's, cmd 13's): Baichuan has no
// terminator, so the client stops at the size it was told. In cam2 the SD
// index on the PVC can outlive the fixtures it was made with (they are rebuilt
// with each image), so the media file may be larger or smaller; the transfer
// then sends its first `size` bytes, or the file and zeros up to `size`. HTTP
// Download instead sends the media file with its own Content-Length, which
// keeps HTTP clients consistent; the two can differ in that case.
export function resolveFile(e: Engine, id: string | undefined): BcFile | undefined {
  const found = id ? e.sd.byName(id) : undefined;
  if (!found) return undefined;
  const media = e.mediaFor(found.rec);
  const size = found.rec.files[found.stream].size;
  const mediaSize = media.clipSize(found.stream);
  if (mediaSize !== size) {
    let seen = warned.get(e);
    if (!seen) warned.set(e, (seen = new Set()));
    if (!seen.has(found.rec.id)) {
      seen.add(found.rec.id);
      e.log.warn({ id: found.rec.id, size, actual: mediaSize }, 'baichuan_size_mismatch');
    }
  }
  return { path: media.clipPath(found.stream), size, mediaSize, stream: found.stream, ...timesOf(found.rec, found.stream) };
}

// cmd 13. Measured: without <name> it reports the <Id>'s size; with <name>
// (01YYYYMMDDhhmmss) it finds the recording by its start time and reports
// the MAIN file's size, also for a sub <Id>. handle is always 0. A file it
// doesn't know: 431 without <name>, 400 with it.
export function fileInfoReply(e: Engine, id: string | undefined, name: string | undefined): { status: number; xml?: string } {
  if (name !== undefined) {
    const m = /^\d{2}(\d{4})(\d{2})(\d{2})(\d{6})$/.exec(name);
    const rec = m ? e.sd.all().find((r) => r.date === `${m[1]}-${m[2]}-${m[3]}` && r.start === m[4]) : undefined;
    if (!rec) return { status: 400 };
    return { status: 200, xml: fileInfoXml({ name, size: rec.files.main.size, ...timesOf(rec, 'main') }) };
  }
  const found = id ? e.sd.byName(id) : undefined;
  if (!found) return { status: 431 };
  return { status: 200, xml: fileInfoXml({ name: '', size: found.rec.files[found.stream].size, ...timesOf(found.rec, found.stream) }) };
}

export interface TransferDeps {
  file: BcFile;
  msgId: number;
  key: Buffer;
  write(frame: Buffer): boolean; // false: wait for drained()
  drained(): Promise<void>;
  alive(): boolean;
  delayMs(): number | undefined; // baichuan.delayMs, read before each chunk
  dropMidway(): boolean; // baichuan.dropMidway, read at the start
  onDrop(): void; // closes the connection
  prev?: TransferLike; // a transfer this one replaced: it starts once that one ends
}

// One cmd-8 transfer. Every frame echoes cmd 8's message id; there is no
// terminator. It reads one chunk at a time and waits for the socket to drain,
// so a slow reader slows it down instead of growing a buffer.
export class Transfer implements TransferLike {
  done = false;
  readonly ended: Promise<void>;
  private endedResolve!: () => void;
  private cancelled = false;
  private tail?: number; // frames still allowed after cmd 9 or a replacing cmd 8
  private recordSent = false;
  private nextChunk = 0; // index of the next chunk to go out
  private prev?: TransferLike; // dropped once it has ended
  private wake?: () => void; // ends a running baichuan.delayMs wait

  constructor(private readonly d: TransferDeps) {
    this.ended = new Promise((r) => (this.endedResolve = r));
    this.prev = d.prev;
  }

  // Ends at once, without a message: the connection is going. Also ends the
  // transfer this one waits for.
  cancel(): void {
    this.cancelled = true;
    this.wake?.();
    this.prev?.cancel();
  }

  stop(): void {
    if (this.tail === undefined) this.tail = FRAMES_AFTER_STOP;
  }

  // A new cmd 8 on the connection: the record if it hasn't gone out yet, the
  // rest of the current 128 KiB block and BLOCKS_AFTER_REPLACE more, then
  // nothing. After cmd 9 the stop's tail stands (abort.txt (2)).
  replace(): void {
    if (this.tail !== undefined) return;
    const toBoundary = (CHUNKS_PER_BLOCK - (this.nextChunk % CHUNKS_PER_BLOCK)) % CHUNKS_PER_BLOCK;
    this.tail = (this.recordSent ? 0 : 1) + toBoundary + BLOCKS_AFTER_REPLACE * CHUNKS_PER_BLOCK;
  }

  async run(): Promise<'complete' | 'stopped' | 'dropped'> {
    try {
      if (this.prev) await this.prev.ended;
      this.prev = undefined;
      return await this.send();
    } finally {
      this.done = true;
      this.endedResolve();
    }
  }

  // May the next frame go out? Checked right before each write, so every
  // frame written after cmd 9 counts toward the tail.
  private go(): boolean {
    if (this.cancelled || !this.d.alive()) return false;
    if (this.tail === undefined) return true;
    if (this.tail <= 0) return false;
    this.tail--;
    return true;
  }

  // The baichuan.delayMs wait: unref'd, and cancel() (a drop, logout or
  // close()) ends it at once, so neither the timer nor the open file outlives
  // the connection.
  private sleep(ms: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => this.wake?.(), ms);
      t.unref();
      this.wake = () => {
        clearTimeout(t);
        this.wake = undefined;
        resolve();
      };
    });
  }

  private async write(frame: Buffer): Promise<void> {
    if (!this.d.write(frame) && this.d.alive()) await this.d.drained();
  }

  private async send(): Promise<'complete' | 'stopped' | 'dropped'> {
    const { file, msgId, key } = this.d;
    const fh = await open(file.path, 'r');
    try {
      const enc = ENC[file.stream === 'main' ? 'mainStream' : 'subStream'];
      const record = infoRecord({ width: enc.width, height: enc.height, fps: enc.frameRate, main: file.stream === 'main', start: file.start, end: file.end });
      if (!this.go()) return 'stopped';
      this.recordSent = true;
      await this.write(encodeFrame({ cmd: 8, msgId, status: 200, cls: CLS_CAMERA, ext: aesEncrypt(key, Buffer.from(EXT_BINARY)), body: record }));
      const ext = aesEncrypt(key, Buffer.from(EXT_CHUNK));
      const half = this.d.dropMidway() ? Math.floor(file.size / 2) : Infinity;
      let sent = 0;
      for (let i = 0; sent < file.size; i++) {
        const n = chunkSize(i, file.size - sent);
        if (sent + n > half) {
          this.d.onDrop();
          return 'dropped';
        }
        const ms = this.d.delayMs();
        if (ms) await this.sleep(ms);
        // Zero-filled: past the end of a smaller media file the zeros go out.
        const buf = Buffer.alloc(n);
        const want = Math.max(0, Math.min(n, file.mediaSize - sent));
        if (want > 0) {
          const { bytesRead } = await fh.read(buf, 0, want, sent);
          if (bytesRead !== want) throw new Error('the recording file changed during a transfer');
        }
        if (!this.go()) return 'stopped';
        this.nextChunk = i + 1;
        await this.write(encodeFrame({ cmd: 8, msgId, status: 200, cls: CLS_CAMERA, ext, body: encryptChunk(key, buf, ENCRYPT_LEN) }));
        sent += n;
      }
      return 'complete';
    } finally {
      await fh.close();
    }
  }
}
