import { Readable } from 'stream';
import { Client } from 'basic-ftp';
import type { Engine } from '../engine/engine';
import type { Recording } from '../engine/sdcard';

// Schedule table key per trigger type (Ftp.schedule.table, as for Rec).
const SCHEDULE_KEY: Record<string, string> = { motion: 'MD', person: 'AI_PEOPLE', vehicle: 'AI_VEHICLE', pet: 'AI_DOG_CAT' };
const TIMEOUT_MS = 15_000;

export interface FtpTarget {
  server: string;
  port: number;
  userName: string;
  password: string;
  onlyFtps: number;
}

// Connects and logs in the way the camera does: explicit FTPS when onlyFtps
// is 1 (the default), plain FTP otherwise; the server certificate is not
// verified (the camera doesn't).
export async function connect(t: FtpTarget): Promise<Client> {
  const client = new Client(TIMEOUT_MS);
  client.ftp.verbose = false;
  await client.access({
    host: t.server,
    port: Number(t.port) || 21,
    user: t.userName,
    password: t.password,
    secure: t.onlyFtps === 1,
    secureOptions: { rejectUnauthorized: false },
  });
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Uploads each finished recording like the RLC-1224A: the clip of the chosen
// stream and a JPEG, to <remoteDir>/YYYY/MM/DD/<Name>_00_YYYYMMDDHHMMSS.*,
// one at a time. Failures are logged and counted, not retried. At most
// MAX_PENDING wait; more are dropped (counted), so a slow server can't grow
// the backlog without bound.
export const MAX_PENDING = 20;

export class FtpUploader {
  private readonly queue: Recording[] = [];
  private running = false;
  private stopped = false;
  private readonly onRecording = (rec: Recording | undefined) => {
    if (!rec || this.stopped) return;
    if (this.queue.length >= MAX_PENDING) {
      this.engine.counters.ftpDropped++;
      return;
    }
    this.queue.push(rec);
    queueMicrotask(() => void this.work());
  };

  constructor(private readonly engine: Engine) {
    engine.events.on('recording', this.onRecording);
  }

  pending(): number {
    return this.queue.length;
  }

  // Unsubscribes and drops what is waiting; an upload in flight finishes.
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.engine.events.off('recording', this.onRecording);
  }

  private async work(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let rec = this.queue.shift(); rec && !this.stopped; rec = this.queue.shift()) await this.uploadRecording(rec);
    } finally {
      this.running = false;
    }
  }

  async uploadRecording(rec: Recording): Promise<void> {
    const e = this.engine;
    const ftp = e.settings.running.Ftp;
    if (ftp.enable !== 1 || !ftp.server) return;
    const weekday = new Date(`${rec.date}T12:00:00Z`).getUTCDay();
    const slot = weekday * 24 + Number(rec.start.slice(0, 2));
    const scheduled = rec.triggers.some((t) => String(ftp.schedule?.table?.[SCHEDULE_KEY[t]] ?? '')[slot] === '1');
    if (!scheduled) return;

    const stem = `${e.config.name}_00_${rec.date.replaceAll('-', '')}${rec.start}`;
    const dir = [String(ftp.remoteDir ?? '').replace(/\/+$/, ''), ftp.autoDir === 1 ? rec.date.replaceAll('-', '/') : ''].filter(Boolean).join('/');
    const file = `${dir ? `${dir}/` : ''}${stem}.mp4`;
    const stream = ftp.streamType === 1 ? 'sub' : 'main';
    let client: Client | undefined;
    try {
      const delay = e.faults.active('ftp.delayMs')?.ms;
      if (delay) await sleep(delay);
      if (e.faults.consume('ftp.fail')) throw new Error('ftp.fail fault');
      client = await connect(ftp as FtpTarget);
      if (dir) await client.ensureDir(dir);
      const media = e.mediaFor(rec);
      await client.uploadFrom(media.clipPath(stream), `${stem}.mp4`);
      await client.uploadFrom(Readable.from(await media.snapshot()), `${stem}.jpg`);
      e.counters.ftpUploads++;
      e.bus.emit('ftp', { file, ok: true });
    } catch (err) {
      e.counters.ftpFailures++;
      e.log.warn({ err: (err as Error).message, stem }, 'ftp_upload_failed');
      e.bus.emit('ftp', { file, ok: false, error: (err as Error).message });
    } finally {
      client?.close();
    }
  }
}

// TestFtp: the whole Ftp object is required (the firmware answers -56 for a
// partial one, measured); it connects and logs in, and never saves anything.
// An unreachable server or a refused login answers -454 (measured).
export async function testFtp(engine: Engine, ftp: Record<string, unknown> | undefined): Promise<number | null> {
  const need = ['server', 'port', 'userName', 'password', 'remoteDir', 'onlyFtps'];
  if (!ftp || typeof ftp !== 'object' || need.some((k) => !(k in ftp))) return -56;
  if (engine.faults.consume('ftp.fail')) return -454;
  let client: Client | undefined;
  try {
    // Connect and log in only: uploads create remoteDir as needed, so a
    // folder that doesn't exist yet is not an error.
    client = await connect(ftp as unknown as FtpTarget);
    return null;
  } catch {
    return -454;
  } finally {
    client?.close();
  }
}
