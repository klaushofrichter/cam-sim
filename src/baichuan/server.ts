// cam-sim's Baichuan server (the camera's TCP port 9000): connections, login,
// sessions, and (vod.ts) recordings download. It answers like the RLC-1224A
// in reference/rlc-1224a/baichuan/. Protocol after reolink_aio 5d37cb3 and
// PR #186 9a1bb52 (MIT, THIRD_PARTY_NOTICES). Nothing here logs a body, a
// password, a nonce or a key.
import net, { type AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import type { Engine } from '../engine/engine';
import { BAICHUAN_OVER_LIMIT_HELD_MAX, BAICHUAN_SESSION_LIMIT, type CamSimConfig, type User } from '../config';
import { CLS_CAMERA, CLS_NONCE_REPLY, CLS_NONCE_REQUEST, ENC_CHOICE, FrameParser, channelOf, encodeFrame, type BcFrame } from './frame';
import { aesDecrypt, aesEncrypt, aesKey, bcXor, md5_31 } from './cipher';
import { LATE_AFTER_LINK_TYPE_MS, LINK_TYPE_XML, LOGIN_ERR_XML, PUSHES, loginReplyXml, nonceXml, tagValue, type PushMessage } from './xml';
import { FIRST_REPLY_LEN, Transfer, fileInfoReply, resolveFile } from './vod';

// Defaults: config.baichuan (idle close 32 s, 12.5 s before a first message).
export type BaichuanOptions = Partial<CamSimConfig['baichuan']>;

class Conn {
  readonly parser = new FrameParser();
  readonly ip: string;
  counted = true; // within the session limit
  ending = false; // logged out; the close follows
  closed = false;
  nonce?: string;
  user?: User;
  key?: Buffer;
  sessionId?: number;
  idle?: NodeJS.Timeout;
  pushTimers: NodeJS.Timeout[] = [];
  late?: NodeJS.Timeout; // the 291/677/600/669 group, before it went out
  lateArmedByMessage = false; // the first message after login set its timer
  lateSent = false;
  transfer?: Transfer;

  constructor(readonly socket: net.Socket) {
    this.ip = socket.remoteAddress ?? '';
  }
}

type Log = (status: number, replyLen?: number) => void;

// The late push group goes this long before the idle close (PUSHES delayMs).
const LATE_BEFORE_IDLE_MS = PUSHES.find((p) => p.trigger === 'beforeIdleClose')?.delayMs ?? 1;

// The traced nonce is 29 characters; its alphabet was redacted.
const newNonce = () => randomBytes(15).toString('hex').toUpperCase().slice(0, 29);

export class BaichuanServer {
  private readonly server: net.Server;
  private readonly conns = new Set<Conn>();
  private readonly idleMs: number;
  private readonly firstMessageMs: number;
  private readonly hooks = { dropAll: () => this.dropAll(), dropTransfers: () => this.dropTransfers() };
  private readonly onFaults = () => {
    if (this.engine.down()) this.dropAll();
  };

  constructor(private readonly engine: Engine, opts: BaichuanOptions = {}) {
    this.idleMs = opts.idleMs ?? engine.config.baichuan.idleMs;
    this.firstMessageMs = opts.firstMessageMs ?? engine.config.baichuan.firstMessageMs;
    this.server = net.createServer((s) => this.accept(s));
    engine.baichuan = this.hooks;
    engine.faults.on('change', this.onFaults);
  }

  listen(port: number, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  // Ends every connection first: net.Server.close() waits for them.
  async close(): Promise<void> {
    this.engine.faults.off('change', this.onFaults);
    if (this.engine.baichuan === this.hooks) this.engine.baichuan = undefined;
    this.dropAll();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // For tests: open connections (logged in or not) and their unsent bytes.
  connectionCount(): number {
    return this.conns.size;
  }

  writeBacklog(): number {
    let n = 0;
    for (const c of this.conns) n += c.socket.writableLength;
    return n;
  }

  // Ends every connection now, its session and timers included (no waiting
  // for the sockets' close events).
  dropAll(): void {
    for (const c of [...this.conns]) {
      c.socket.destroy();
      this.onClose(c);
    }
  }

  // downloads.dropActive: a running transfer's connection closes.
  dropTransfers(): void {
    for (const c of this.conns) {
      if (!c.transfer || c.transfer.done) continue;
      this.engine.counters.droppedBaichuanDownloads++;
      c.socket.destroy();
    }
  }

  // The fault can only lower the measured limit.
  private limit(): number {
    return Math.min(this.engine.faults.active('baichuan.sessionLimit')?.max ?? BAICHUAN_SESSION_LIMIT, BAICHUAN_SESSION_LIMIT);
  }

  private accept(socket: net.Socket): void {
    socket.on('error', () => undefined);
    if (this.engine.down()) return void socket.resetAndDestroy();
    const c = new Conn(socket);
    // Measured: connections over the limit are accepted, then reset at their
    // first message; connections that never logged in count too.
    let counted = 0;
    for (const x of this.conns) if (x.counted) counted++;
    c.counted = counted < this.limit();
    // cam-sim's cap on the held over-limit connections (config.ts).
    if (!c.counted && this.conns.size - counted >= BAICHUAN_OVER_LIMIT_HELD_MAX) return void socket.resetAndDestroy();
    this.conns.add(c);
    this.armIdle(c, this.firstMessageMs);
    socket.on('data', (d: Buffer) => this.onData(c, d));
    socket.on('close', () => this.onClose(c));
  }

  private onData(c: Conn, data: Buffer): void {
    if (c.closed || c.ending) return;
    if (!c.counted || this.engine.down()) return void c.socket.resetAndDestroy();
    let frames: BcFrame[];
    try {
      frames = c.parser.push(data);
    } catch {
      // Measured: bad magic closes the connection without a reply. A declared
      // body beyond MAX_BODY throws here too, before anything is buffered.
      return void c.socket.destroy();
    }
    for (const f of frames) {
      if (c.closed || c.ending || c.socket.destroyed) return;
      this.handle(c, f);
    }
  }

  // Every way a connection ends (logout, idle, fault, the client vanishing,
  // close()) comes here: no timer, session or transfer stays behind.
  private onClose(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    clearTimeout(c.idle);
    clearTimeout(c.late);
    for (const t of c.pushTimers) clearTimeout(t);
    c.transfer?.cancel();
    this.conns.delete(c);
    if (c.sessionId !== undefined) {
      this.engine.sessions.closeBaichuan(c.sessionId);
      this.engine.counters.baichuanSessions--;
    }
  }

  // Measured: about 32 s after the client's last message, 12.5 s for a
  // connection that never sends. A running download keeps it open (measured
  // 2026-10-02 on the real camera: a 9 MB main file read throttled for 77.6 s
  // stayed up, no drop). What is chosen, not measured, is that a reader that
  // never reads keeps its connection and its slot of the 12 for as long as the
  // transfer waits for drain (README "What differs").
  private armIdle(c: Conn, ms: number): void {
    clearTimeout(c.idle);
    c.idle = setTimeout(() => {
      if (c.transfer && !c.transfer.done) return this.armIdle(c, ms);
      // The late group goes out before the close, whatever the timers did.
      if (c.key && !c.lateSent) this.sendLate(c);
      this.closeAfterFlush(c);
    }, ms);
    c.idle.unref();
    if (c.key && !c.lateSent && !c.lateArmedByMessage) this.armLate(c, Math.max(0, ms - LATE_BEFORE_IDLE_MS));
  }

  private handle(c: Conn, f: BcFrame): void {
    const t0 = Date.now();
    const { cmd, msgId } = f.header;
    const log: Log = (status, replyLen = 0) =>
      this.engine.recordRequest({
        at: new Date(t0).toISOString(), port: 'baichuan', method: 'BC', path: '', cmd: String(cmd),
        status, ms: Date.now() - t0, len: f.header.bodyLen, replyLen,
      });
    this.armIdle(c, this.idleMs);
    if (!c.key) return this.login(c, f, log);
    // Measured: the client's first message after login brings the late group
    // (this replaces the timer armIdle set for it). Only the first: later
    // messages must not postpone it.
    if (!c.lateSent && !c.lateArmedByMessage) {
      c.lateArmedByMessage = true;
      this.armLate(c, LATE_AFTER_LINK_TYPE_MS);
    }
    switch (cmd) {
      case 2: {
        // Logout: 200, then the camera closes the connection.
        log(200, this.reply(c, cmd, msgId, 200));
        c.transfer?.cancel();
        this.closeAfterFlush(c);
        return;
      }
      case 8:
        return this.download(c, f, log);
      case 9:
        // Stop: 200 at once; the chunks in flight still come (vod.ts).
        this.engine.counters.baichuanStops++;
        c.transfer?.stop();
        return log(200, this.reply(c, cmd, msgId, 200));
      case 13: {
        const xml = this.requestXml(c, f);
        const r = fileInfoReply(this.engine, tagValue(xml, 'Id'), tagValue(xml, 'name') || undefined);
        return log(r.status, this.reply(c, cmd, msgId, r.status, r.xml));
      }
      case 93:
        return log(200, this.reply(c, cmd, msgId, 200, LINK_TYPE_XML));
      default:
        // Measured: an unknown command answers 405; the session stays usable.
        return log(405, this.reply(c, cmd, msgId, 405));
    }
  }

  private login(c: Conn, f: BcFrame, log: Log): void {
    const { cmd, msgId, cls } = f.header;
    const ch = channelOf(msgId);
    if (cmd === 1 && cls === CLS_NONCE_REQUEST) {
      c.nonce = newNonce();
      const body = bcXor(Buffer.from(nonceXml(c.nonce)), ch);
      this.send(c, encodeFrame({ cmd, msgId, status: ENC_CHOICE, cls: CLS_NONCE_REPLY, body }));
      return log(200, body.length);
    }
    // Measured: any other request before login closes without a reply.
    if (cmd !== 1 || !c.nonce) {
      log(0);
      return void c.socket.destroy();
    }
    const nonce = c.nonce;
    const xml = bcXor(f.body, ch).toString('utf8');
    const userHash = tagValue(xml, 'userName');
    const passHash = tagValue(xml, 'password');
    // The current user list, so a password or user changed through the camera
    // API applies to the next login.
    const refused = !!this.engine.faults.consume('baichuan.loginFail');
    const user = refused ? undefined : this.engine.sessions.findUser((u) => md5_31(u.name + nonce) === userHash && md5_31(u.password + nonce) === passHash);
    if (!user) {
      // Measured: 401 with remainTimes 10; the connection stays open.
      const body = bcXor(Buffer.from(LOGIN_ERR_XML), ch);
      this.send(c, encodeFrame({ cmd, msgId, status: 401, cls: CLS_CAMERA, body }));
      return log(401, body.length);
    }
    // The session ends with the connection; a later change or delete of the
    // user leaves it open (unmeasured on the camera; README "What differs").
    c.user = user;
    c.key = aesKey(nonce, user.password);
    c.sessionId = this.engine.sessions.openBaichuan(user, c.ip);
    this.engine.counters.baichuanSessions++;
    this.engine.counters.baichuanLogins++;
    const body = bcXor(Buffer.from(loginReplyXml(randomBytes(8).toString('hex'), randomBytes(8).toString('hex'))), ch);
    this.send(c, encodeFrame({ cmd, msgId, status: 200, cls: CLS_CAMERA, body }));
    log(200, body.length);
    this.schedulePushes(c);
    this.armIdle(c, this.idleMs); // also arms the late group before the idle close
  }

  // The body of a request after login (AES from the fixed IV).
  private requestXml(c: Conn, f: BcFrame): string {
    return f.body.length ? aesDecrypt(c.key!, f.body).toString('utf8') : '';
  }

  private download(c: Conn, f: BcFrame, log: Log): void {
    const { msgId } = f.header;
    const file = resolveFile(this.engine, tagValue(this.requestXml(c, f), 'Id'));
    // Measured: a refusal and a missing file look alike: 400, no body, no chunks.
    if (this.engine.faults.consume('baichuan.refuse') || !file) return log(400, this.reply(c, 8, msgId, 400));
    // Measured: a new cmd 8 silently replaces the running one, which goes on
    // to a block boundary (or its cmd-9 tail) first; the new one waits for it.
    const prev = c.transfer && !c.transfer.done ? c.transfer : undefined;
    prev?.replace();
    this.engine.counters.baichuanDownloads++;
    const socket = c.socket;
    const t = new Transfer({
      prev,
      file,
      msgId,
      key: c.key!,
      write: (frame) => this.send(c, frame),
      drained: () => drained(socket),
      alive: () => !c.closed && !socket.destroyed,
      delayMs: () => this.engine.faults.active('baichuan.delayMs')?.ms,
      dropMidway: () => !!this.engine.faults.active('baichuan.dropMidway'),
      onDrop: () => {
        this.engine.counters.droppedBaichuanDownloads++;
        socket.destroy();
      },
    });
    c.transfer = t;
    log(200, FIRST_REPLY_LEN);
    t.run().catch((err: Error) => {
      // Counted as a download when it started; it ended as a dropped one.
      this.engine.counters.droppedBaichuanDownloads++;
      this.engine.log.warn({ err: err.message }, 'baichuan_transfer_failed');
      socket.destroy();
    });
  }

  // Measured (idle.txt): after a login the camera sends these unsolicited
  // (message id 0, channel 0, status 200): 78/79 0.3 s and 464/547 0.4 s after
  // the login reply. The 291/677/600/669 group comes once per session (armLate).
  private schedulePushes(c: Conn): void {
    const early = PUSHES.filter((p) => p.trigger === 'afterLogin');
    for (const ms of new Set(early.map((p) => p.delayMs))) {
      const t = setTimeout(() => this.sendPushes(c, early.filter((p) => p.delayMs === ms)), ms);
      t.unref();
      c.pushTimers.push(t);
    }
  }

  // The late group: LATE_AFTER_LINK_TYPE_MS after the client's first message
  // after login, or LATE_BEFORE_IDLE_MS before the idle close, whichever is
  // first. Each call replaces the pending timer.
  private armLate(c: Conn, ms: number): void {
    clearTimeout(c.late);
    c.late = setTimeout(() => this.sendLate(c), ms);
    c.late.unref();
  }

  private sendLate(c: Conn): void {
    clearTimeout(c.late);
    if (c.lateSent) return;
    c.lateSent = true;
    this.sendPushes(c, PUSHES.filter((p) => p.trigger === 'beforeIdleClose'));
  }

  // Logout and the idle close: an orderly end (FIN) after the queued frames, as the
  // camera's eof; a peer that does not read is cut off after a second.
  private closeAfterFlush(c: Conn): void {
    // The idle timer handle() just armed would fire later (and re-arm while a
    // cancelled transfer is not done yet); the fallback below replaces it.
    clearTimeout(c.idle);
    c.ending = true;
    c.socket.destroySoon();
    c.idle = setTimeout(() => c.socket.destroy(), 1000);
    c.idle.unref();
  }

  private sendPushes(c: Conn, pushes: readonly PushMessage[]): void {
    if (!c.key || c.closed || c.ending) return;
    for (const p of pushes) this.send(c, encodeFrame({ cmd: p.cmd, msgId: 0, status: 200, cls: CLS_CAMERA, body: aesEncrypt(c.key, Buffer.from(p.xml)) }));
  }

  // An AES reply (no body without xml); answers the body's length.
  private reply(c: Conn, cmd: number, msgId: number, status: number, xml?: string): number {
    const body = xml === undefined ? undefined : aesEncrypt(c.key!, Buffer.from(xml));
    this.send(c, encodeFrame({ cmd, msgId, status, cls: CLS_CAMERA, body }));
    return body?.length ?? 0;
  }

  private send(c: Conn, frame: Buffer): boolean {
    if (c.closed || c.socket.destroyed) return false;
    return c.socket.write(frame);
  }
}

// Resolves once the socket takes more data, or is gone.
function drained(s: net.Socket): Promise<void> {
  if (s.destroyed || !s.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      s.off('drain', done);
      s.off('close', done);
      resolve();
    };
    s.on('drain', done);
    s.on('close', done);
  });
}
