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

// Measured: about 400 KB (13 frames) still arrive after cmd 9.
export const FRAMES_AFTER_STOP = 13;
// The first cmd-8 reply's body: the 106-byte extension and the 32-byte record.
export const FIRST_REPLY_LEN = Buffer.byteLength(EXT_BINARY) + 32;

export interface BcFile {
  path: string;
  size: number;
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

// The file behind cmd 8's <Id>: exactly a name that HTTP Search lists.
export function resolveFile(e: Engine, id: string | undefined): BcFile | undefined {
  const found = id ? e.sd.byName(id) : undefined;
  if (!found) return undefined;
  const media = e.mediaFor(found.rec);
  return { path: media.clipPath(found.stream), size: media.clipSize(found.stream), stream: found.stream, ...timesOf(found.rec, found.stream) };
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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One cmd-8 transfer. Every frame echoes cmd 8's message id; there is no
// terminator. It reads one chunk at a time and waits for the socket to drain,
// so a slow reader slows it down instead of growing a buffer.
export class Transfer implements TransferLike {
  done = false;
  private cancelled = false;
  private tail?: number; // frames still allowed after cmd 9

  constructor(private readonly d: TransferDeps) {}

  cancel(): void {
    this.cancelled = true;
  }

  stop(): void {
    if (this.tail === undefined) this.tail = FRAMES_AFTER_STOP;
  }

  async run(): Promise<'complete' | 'stopped' | 'dropped'> {
    try {
      return await this.send();
    } finally {
      this.done = true;
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
        if (ms) await sleep(ms);
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, sent);
        if (bytesRead !== n) throw new Error('the recording file changed during a transfer');
        if (!this.go()) return 'stopped';
        await this.write(encodeFrame({ cmd: 8, msgId, status: 200, cls: CLS_CAMERA, ext, body: encryptChunk(key, buf, ENCRYPT_LEN) }));
        sent += n;
      }
      return 'complete';
    } finally {
      await fh.close();
    }
  }
}
