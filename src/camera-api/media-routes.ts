import { createReadStream } from 'fs';
import { Transform } from 'stream';
import type { Request, Response } from 'express';
import type { Engine } from '../engine/engine';
import type { FlvTag } from '../media/flv';

// What the firmware sends for a GET with a bad token (Snap and others):
// HTTP 200, text/html, and this JSON as the body text.
export const NOT_LOGGED_IN_GET_BODY = '[{"code":1,"error":{"rspCode":-6,"detail":"please login first"}}]';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The raw (still percent-encoded) value of a query parameter.
function rawParam(req: Request, key: string): string | undefined {
  const q = req.originalUrl.indexOf('?');
  if (q < 0) return undefined;
  const kv = req.originalUrl.slice(q + 1).split('&').find((p) => p.startsWith(`${key}=`));
  return kv?.slice(key.length + 1);
}

const tokenOf = (req: Request) => (typeof req.query.token === 'string' ? req.query.token : undefined);

export async function download(engine: Engine, req: Request, res: Response): Promise<void> {
  const e = engine;
  const rawSource = rawParam(req, 'source') ?? '';
  // Firmware: a percent-encoded source makes the camera drop the connection.
  if (/%2f/i.test(rawSource)) return void req.socket.destroy();
  if (!tokenOf(req) && (req.query.user !== undefined || req.query.password !== undefined)) {
    return void res.status(404).type('text/html').end();
  }
  if (!e.sessions.validate(tokenOf(req))) return void res.status(401).type('text/html').end();
  const drop = () => {
    e.counters.droppedDownloads++;
    req.socket.destroy();
  };
  if (e.faults.consume('downloads.refuse') || e.faults.consume('downloads.dropFirst')) return drop();
  // Download depends on the HTTP service, even when requested over HTTPS.
  if (e.settings.running.NetPort.httpEnable !== 1) return drop();
  const found = e.sd.byName(rawSource);
  if (!found) return void req.socket.destroy();
  // One transfer at a time across the whole device.
  if (e.activeDownloads.size > 0) return void req.socket.destroy();

  e.counters.downloads++;
  e.counters.noteDownload(found.rec.start);
  e.counters.activeDownloads++;
  e.activeDownloads.add(res);
  res.on('close', () => {
    e.counters.activeDownloads--;
    e.activeDownloads.delete(res);
  });
  const delay = e.faults.active('downloads.delayMs')?.ms;
  if (delay) await sleep(delay);
  if (res.destroyed || res.writableEnded) return;

  const path = e.media.clipPath(found.stream);
  const size = e.media.clipSize(found.stream);
  const cutAt = e.faults.active('downloads.dropMidway') ? Math.floor(size / 2) : Infinity;
  const bps = e.timings.downloadBytesPerS;
  let sent = 0;
  const shaper = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (sent + chunk.length > cutAt) {
        this.push(chunk.subarray(0, cutAt - sent));
        sent = cutAt;
        setImmediate(() => res.destroy());
        return cb();
      }
      sent += chunk.length;
      if (!bps) return cb(null, chunk);
      setTimeout(() => cb(null, chunk), (chunk.length / bps) * 1000);
    },
  });
  // Content-Length as the firmware's download sends it (cams forwards it);
  // not re-measured since the camera stopped serving downloads.
  res.status(200).type('video/mp4').setHeader('Content-Length', String(size));
  const file = createReadStream(path, { highWaterMark: 16 * 1024 });
  res.on('close', () => file.destroy());
  file.pipe(shaper).pipe(res);
}

export async function snap(engine: Engine, req: Request, res: Response): Promise<void> {
  if (!engine.sessions.validate(tokenOf(req))) return void res.status(200).type('text/html').send(NOT_LOGGED_IN_GET_BODY);
  if (engine.faults.active('snap.fail')) return void res.status(500).type('text/html').end();
  res.type('image/jpeg').send(await engine.media.snapshot());
}

// A tag with its timestamp moved by `offsetMs` (for looping the fixture).
function shifted(tag: FlvTag, offsetMs: number): Buffer {
  if (!offsetMs) return tag.bytes;
  const b = Buffer.from(tag.bytes);
  const ms = tag.ms + offsetMs;
  b.writeUIntBE(ms & 0xffffff, 4, 3);
  b[7] = (ms >>> 24) & 0xff;
  return b;
}

const isConfig = (t: FlvTag) => (t.type === 9 || t.type === 8) && t.bytes[12] === 0;
// AVC/HEVC end of sequence: never mid-stream (a live camera doesn't end).
const isEndOfSequence = (t: FlvTag) => t.type === 9 && t.bytes[12] === 2;

// The camera's /flv endpoint: token, fault and RTMP checks, then the stream.
export async function flv(engine: Engine, req: Request, res: Response): Promise<void> {
  const e = engine;
  if (!e.sessions.validate(tokenOf(req)) || e.faults.active('flv.reset') || e.settings.running.NetPort.rtmpEnable !== 1) {
    return void req.socket.destroy();
  }
  const delay = e.faults.active('flv.delayMs')?.ms;
  if (delay) await sleep(delay);
  if (res.destroyed || res.writableEnded) return;
  const stream = /channel0_main/.test(String(req.query.stream ?? '')) ? 'main' : 'sub';
  streamFlv(e, res, stream, { count: true });
}

// Endless video/x-flv, paced by tag timestamps; the fixture loops with
// increasing timestamps (a camera never ends a stream on its own). `count`
// is false for the web UI's viewer, which isn't a camera client.
export function streamFlv(engine: Engine, res: Response, stream: 'sub' | 'main', opts: { count: boolean }): void {
  const e = engine;
  const { header, tags: all } = e.media.liveFlv(stream);
  const tags = all.filter((t) => !isEndOfSequence(t));
  const loopMs = e.media.durationMs(stream);
  const loopTags = tags.filter((t) => t.type !== 18 && !isConfig(t));
  const canLoop = loopMs > 0 && loopTags.length > 0;

  if (opts.count) {
    e.counters.activeStreams++;
    e.counters.streamsOpened++;
  }
  e.activeFlv.add(res);
  const began = Date.now();
  let pass = 0;
  let next = 0;
  const pump = () => {
    const due = Date.now() - began;
    for (;;) {
      const list = pass === 0 ? tags : loopTags;
      if (next >= list.length) {
        if (!canLoop) return; // nothing to repeat: stay open, silent
        pass++;
        next = 0;
        continue;
      }
      const t = list[next];
      const at = t.ms + pass * loopMs;
      if (at > due) break;
      res.write(shifted(t, pass * loopMs));
      next++;
      // A viewer that stops reading is dropped, like a camera does, rather
      // than buffering without bound.
      if (res.writableLength > e.limits.flvBufferBytes) {
        res.destroy();
        return;
      }
    }
  };
  const timer = setInterval(pump, 20);
  res.on('close', () => {
    clearInterval(timer);
    if (opts.count) e.counters.activeStreams--;
    e.activeFlv.delete(res);
  });
  res.status(200).type('video/x-flv');
  res.write(header);
  pump();
}
