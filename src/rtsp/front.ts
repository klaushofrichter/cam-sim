// The camera's RTSP port in front of MediaMTX: every client connection is
// passed through to MediaMTX on the loopback, byte for byte, except the SDP
// of a DESCRIBE answer, which is shaped like the model's (src/rtsp/sdp.ts).
// RTSP over TCP: text messages (headers, an optional body of Content-Length
// bytes) and, after PLAY, interleaved binary frames ('$', channel, 16-bit
// length). Clients only read here: an ANNOUNCE or RECORD (publishing) closes
// the connection, since MediaMTX sees every client as the loopback.
import net from 'net';
import { shapeSdp, type SdpShape } from './sdp';

// A message head larger than this is not RTSP: the connection is closed.
const MAX_HEAD = 64 * 1024;

type Message = { kind: 'frame'; bytes: Buffer } | { kind: 'text'; head: string; body: Buffer };

// Splits a byte stream into RTSP messages and interleaved frames.
export class RtspSplitter {
  private buf: Buffer = Buffer.alloc(0);

  // The complete messages in `chunk` (and what came before); null: not RTSP.
  push(chunk: Buffer): Message[] | null {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Message[] = [];
    for (;;) {
      if (!this.buf.length) return out;
      if (this.buf[0] === 0x24) {
        if (this.buf.length < 4) return out;
        const n = 4 + this.buf.readUInt16BE(2);
        if (this.buf.length < n) return out;
        out.push({ kind: 'frame', bytes: this.buf.subarray(0, n) });
        this.buf = this.buf.subarray(n);
        continue;
      }
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return this.buf.length > MAX_HEAD ? null : out;
      if (end > MAX_HEAD) return null;
      const head = this.buf.subarray(0, end + 4).toString('latin1');
      const m = /^content-length:\s*(\d+)\s*$/im.exec(head);
      const len = m ? Number(m[1]) : 0;
      if (len > 16 * 1024 * 1024) return null;
      if (this.buf.length < end + 4 + len) return out;
      out.push({ kind: 'text', head, body: this.buf.subarray(end + 4, end + 4 + len) });
      this.buf = this.buf.subarray(end + 4 + len);
    }
  }
}

// An answer with an SDP body, shaped; anything else as it came.
export function shapeMessage(m: Message, shape: SdpShape): Buffer {
  if (m.kind === 'frame') return m.bytes;
  if (!m.body.length || !/^content-type:\s*application\/sdp\s*$/im.test(m.head)) return Buffer.concat([Buffer.from(m.head, 'latin1'), m.body]);
  const body = Buffer.from(shapeSdp(m.body.toString('utf8'), shape), 'utf8');
  const head = m.head.replace(/^(content-length:\s*)\d+/im, `$1${body.length}`);
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

const PUBLISHING = /^(ANNOUNCE|RECORD) /;

export class RtspFront {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly o: { upstreamPort: () => number; shape: () => SdpShape }) {}

  // Listens on `port` (0: a free one) at `host` (undefined: every
  // interface, as MediaMTX did); rejects when the port is taken.
  listen(port: number, host: string | undefined): Promise<number> {
    const server = net.createServer((client) => this.connect(client));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const done = () => {
        server.off('error', reject);
        resolve((server.address() as net.AddressInfo).port);
      };
      if (host === undefined) server.listen(port, done);
      else server.listen(port, host, done);
    });
  }

  private connect(client: net.Socket): void {
    const up = net.connect(this.o.upstreamPort(), '127.0.0.1');
    for (const s of [client, up]) {
      this.sockets.add(s);
      s.setNoDelay(true);
      s.on('close', () => this.sockets.delete(s));
    }
    const end = () => {
      client.destroy();
      up.destroy();
    };
    client.on('error', end).on('close', end);
    up.on('error', end).on('close', end);
    const fromClient = new RtspSplitter();
    const fromUp = new RtspSplitter();
    client.on('data', (d: Buffer) => {
      const ms = fromClient.push(d);
      if (!ms) return end();
      for (const m of ms) {
        if (m.kind === 'text' && PUBLISHING.test(m.head)) return end();
        up.write(m.kind === 'frame' ? m.bytes : Buffer.concat([Buffer.from(m.head, 'latin1'), m.body]));
      }
    });
    up.on('data', (d: Buffer) => {
      const ms = fromUp.push(d);
      if (!ms) return end();
      const shape = this.o.shape();
      for (const m of ms) {
        // Backpressure: a slow client slows only its own MediaMTX connection.
        if (!client.write(shapeMessage(m, shape))) up.pause();
      }
    });
    client.on('drain', () => up.resume());
  }

  // Closes the port and every connection through it.
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}
