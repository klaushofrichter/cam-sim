import { Readable } from 'stream';
import { Client, enterPassiveModeIPv4 } from 'basic-ftp';
import { localParts } from '../engine/clock';
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

// Opens a session the way the RLC-1224A does (measured against cam-proxy's
// server, 2026-09-27, cam-sim#25): explicit TLS first when onlyFtps is 1
// (the certificate isn't verified), USER/PASS, PWD. Transfers use PASV only
// (never EPSV), after TYPE, MODE S and, with TLS, PBSZ 0 / PROT P.
export async function connect(t: FtpTarget): Promise<Client> {
  const client = new Client(TIMEOUT_MS);
  client.ftp.verbose = false;
  client.prepareTransfer = enterPassiveModeIPv4;
  try {
    await client.connect(t.server, Number(t.port) || 21);
    if (t.onlyFtps === 1) await client.useTLS({ rejectUnauthorized: false, host: t.server });
    await client.login(t.userName, t.password);
    await client.send('PWD');
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}

async function transferMode(client: Client, type: 'A' | 'I', tls: boolean): Promise<void> {
  await client.send(`TYPE ${type}`);
  await client.send('MODE S');
  if (tls) {
    await client.send('PBSZ 0');
    await client.send('PROT P');
  }
}

// Into remoteDir/YYYY/MM/DD one folder at a time: CWD, and MKD then CWD when
// it doesn't exist yet.
async function enter(client: Client, dir: string): Promise<void> {
  for (const name of dir.split('/').filter(Boolean)) {
    try {
      await client.send(`CWD ${name}`);
    } catch {
      await client.send(`MKD ${name}`);
      await client.send(`CWD ${name}`);
    }
  }
}

// One session: into the folder, then one file (close() sends QUIT).
async function uploadOne(t: FtpTarget, dir: string, source: string | Readable, name: string): Promise<void> {
  const client = await connect(t);
  try {
    await enter(client, dir);
    await transferMode(client, 'I', t.onlyFtps === 1);
    await client.uploadFrom(source, name);
  } finally {
    client.close();
  }
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

  // A factory reset drops what is waiting (an upload in flight finishes).
  private readonly onFactoryReset = () => {
    this.queue.length = 0;
  };

  constructor(private readonly engine: Engine) {
    engine.events.on('recording', this.onRecording);
    engine.bus.on('factory-reset', this.onFactoryReset);
  }

  pending(): number {
    return this.queue.length;
  }

  // Unsubscribes and drops what is waiting; an upload in flight finishes.
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.engine.events.off('recording', this.onRecording);
    this.engine.bus.off('factory-reset', this.onFactoryReset);
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
    try {
      const delay = e.faults.active('ftp.delayMs')?.ms;
      if (delay) await sleep(delay);
      if (e.faults.consume('ftp.fail')) throw new Error('ftp.fail fault');
      const media = e.mediaFor(rec);
      const target = ftp as FtpTarget;
      // The camera sends the snapshot in a second session while the clip
      // is still uploading.
      await Promise.all([
        uploadOne(target, dir, media.clipPath(stream), `${stem}.mp4`),
        media.snapshot().then((jpeg) => uploadOne(target, dir, Readable.from(jpeg), `${stem}.jpg`)),
      ]);
      e.counters.ftpUploads++;
      e.bus.emit('ftp', { file, ok: true });
    } catch (err) {
      e.counters.ftpFailures++;
      e.log.warn({ err: (err as Error).message, stem }, 'ftp_upload_failed');
      e.bus.emit('ftp', { file, ok: false, error: (err as Error).message });
    }
  }
}

// TestFtp: the whole Ftp object is required (the firmware answers -56 for a
// partial one, measured). Like the camera it runs a whole session and stores
// a small <Name>_00_<local time>.txt (measured against cam-proxy, 2026-09-27)
// in the current folder; it never saves the settings. An unreachable server,
// a refused login or a failed upload answers -454 (measured).
export async function testFtp(engine: Engine, ftp: Record<string, unknown> | undefined): Promise<number | null> {
  const need = ['server', 'port', 'userName', 'password', 'remoteDir', 'onlyFtps'];
  if (!ftp || typeof ftp !== 'object' || need.some((k) => !(k in ftp))) return -56;
  if (engine.faults.consume('ftp.fail')) return -454;
  const t = ftp as unknown as FtpTarget;
  let client: Client | undefined;
  try {
    client = await connect(t);
    await transferMode(client, 'A', t.onlyFtps === 1);
    const p = localParts(engine.clock, engine.config.tz);
    await client.uploadFrom(Readable.from([Buffer.from('FTP test\r\n')]), `${engine.config.name}_00_${p.date.replaceAll('-', '')}${p.hms}.txt`);
    return null;
  } catch {
    return -454;
  } finally {
    client?.close();
  }
}
