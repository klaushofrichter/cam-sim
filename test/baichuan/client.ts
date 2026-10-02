// A minimal Baichuan client for cam-sim's tests. It shares only the frame
// codec and the ciphers with the server; those are pinned to reolink_aio
// vectors and to the traces (frame.test.ts, cipher.test.ts, traces.test.ts).
import net from 'net';
import { CLS_CLIENT, CLS_NONCE_REQUEST, ENC_OFFER, FrameParser, HOST_CHANNEL, encodeFrame, type BcFrame } from '../../src/baichuan/frame';
import { aesDecrypt, aesEncrypt, aesKey, bcXor, decryptChunk, md5_31 } from '../../src/baichuan/cipher';
import { tagValue } from '../../src/baichuan/xml';

const DECL = '<?xml version="1.0" encoding="UTF-8" ?>';
const lines = (l: string[]) => l.map((x) => `${x}\n`).join('');
const fileInfoList = (children: string[]) => lines([DECL, '<body>', '<FileInfoList version="1.1">', '<FileInfo>', ...children, '</FileInfo>', '</FileInfoList>', '</body>']);

// reolink_aio's LOGIN_XML and LOGOUT_XML (xmls.py L3-L25), and PR #186's
// VOD templates, as the traces show them.
export const loginXml = (userHash: string, passHash: string) => lines([
  DECL, '<body>', '<LoginUser version="1.1">', `<userName>${userHash}</userName>`, `<password>${passHash}</password>`, '<userVer>1</userVer>', '</LoginUser>',
  '<LoginNet version="1.1">', '<type>LAN</type>', '<udpPort>0</udpPort>', '</LoginNet>', '</body>',
]);
export const logoutXml = (user: string, password: string) => lines([
  DECL, '<body>', '<LoginUser version="1.1">', `<userName>${user}</userName>`, `<password>${password}</password>`, '<userVer>1</userVer>', '</LoginUser>', '</body>',
]);
export const downloadXml = (id: string, name?: string) => fileInfoList([`<Id>${id}</Id>`, '<channelId>0</channelId>', ...(name ? [`<name>${name}</name>`] : [])]);
export const fileInfoRequestXml = downloadXml; // cmd 13 sends the same children
export const stopXml = () => fileInfoList(['<channelId>0</channelId>', '<handle>0</handle>']);

export const msgIdOf = (n: number) => HOST_CHANNEL | (n << 8);

export class BcClient {
  readonly frames: BcFrame[] = [];
  readonly times: number[] = []; // when each frame arrived (ms)
  key?: Buffer;
  nonce?: string;
  closed = false;
  readonly ended: Promise<'eof' | 'reset'>;
  private counter = 1;
  private readonly parser = new FrameParser(64 * 1024 * 1024);
  private waiters: Array<() => void> = [];

  private constructor(readonly socket: net.Socket) {
    let reset = false;
    let done!: (v: 'eof' | 'reset') => void;
    this.ended = new Promise((r) => (done = r));
    socket.on('data', (d: Buffer) => {
      for (const f of this.parser.push(d)) {
        this.frames.push(f);
        this.times.push(Date.now());
      }
      this.wake();
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNRESET' || e.code === 'EPIPE') reset = true;
    });
    socket.on('close', () => {
      this.closed = true;
      done(reset ? 'reset' : 'eof');
      this.wake();
    });
  }

  static connect(port: number): Promise<BcClient> {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => resolve(new BcClient(s)));
      s.once('error', reject);
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  // The index of the first frame at or after `from` that matches.
  async waitIndex(pred: (f: BcFrame) => boolean, ms = 3000, from = 0): Promise<number> {
    const deadline = Date.now() + ms;
    for (let i = from; ; ) {
      for (; i < this.frames.length; i++) if (pred(this.frames[i])) return i;
      if (this.closed) throw new Error('connection closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a frame');
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async waitFor(pred: (f: BcFrame) => boolean, ms = 3000): Promise<BcFrame> {
    return this.frames[await this.waitIndex(pred, ms)];
  }

  reply(msgId: number, cmd: number, ms?: number): Promise<BcFrame> {
    return this.waitFor((f) => f.header.cmd === cmd && f.header.msgId === msgId, ms);
  }

  nextId(): number {
    return msgIdOf(this.counter++);
  }

  write(raw: Buffer): void {
    this.socket.write(raw);
  }

  async nonceRequest(): Promise<string> {
    const msgId = this.nextId();
    this.write(encodeFrame({ cmd: 1, msgId, status: ENC_OFFER, cls: CLS_NONCE_REQUEST }));
    const f = await this.reply(msgId, 1);
    const nonce = tagValue(bcXor(f.body, msgId & 0xff).toString('utf8'), 'nonce');
    if (!nonce) throw new Error('no nonce in the reply');
    this.nonce = nonce;
    return nonce;
  }

  // The nonce exchange (once per connection), then the login; keeps the key on 200.
  async login(user: string, password: string): Promise<BcFrame> {
    const nonce = this.nonce ?? (await this.nonceRequest());
    const msgId = this.nextId();
    const body = bcXor(Buffer.from(loginXml(md5_31(user + nonce), md5_31(password + nonce))), msgId & 0xff);
    this.write(encodeFrame({ cmd: 1, msgId, status: 0, cls: CLS_CLIENT, body }));
    const f = await this.reply(msgId, 1);
    if (f.header.status === 200) this.key = aesKey(nonce, password);
    return f;
  }

  // An AES request after login; answers its message id.
  send(cmd: number, xml?: string): number {
    const msgId = this.nextId();
    const body = xml === undefined ? undefined : aesEncrypt(this.key!, Buffer.from(xml));
    this.write(encodeFrame({ cmd, msgId, status: 0, cls: CLS_CLIENT, body }));
    return msgId;
  }

  call(cmd: number, xml?: string, ms?: number): Promise<BcFrame> {
    return this.reply(this.send(cmd, xml), cmd, ms);
  }

  // Like reolink_aio: AES first, then the XOR, then plain text.
  text(f: BcFrame, part: 'body' | 'ext' = 'body'): string {
    const raw = part === 'ext' ? f.ext : f.body;
    if (!raw.length) return '';
    if (this.key) {
      const a = aesDecrypt(this.key, raw).toString('utf8');
      if (a.startsWith('<?xml')) return a;
    }
    const x = bcXor(raw, f.header.msgId & 0xff).toString('utf8');
    return x.startsWith('<?xml') ? x : raw.toString('utf8');
  }

  // cmd 8 for `id`, then `size` bytes of chunks after the 32-byte info record.
  download(id: string, size: number, opts: { name?: string; ms?: number } = {}) {
    return this.collect(this.send(8, downloadXml(id, opts.name)), size, opts.ms);
  }

  async collect(msgId: number, size: number, ms = 5000): Promise<{ msgId: number; status: number; info: Buffer; data: Buffer; frames: number }> {
    const mine = (f: BcFrame) => f.header.cmd === 8 && f.header.msgId === msgId;
    let i = await this.waitIndex(mine, ms);
    const first = this.frames[i];
    if (first.header.status !== 200) return { msgId, status: first.header.status, info: first.body, data: Buffer.alloc(0), frames: 1 };
    const parts: Buffer[] = [];
    let got = 0;
    let frames = 1;
    while (got < size) {
      i = await this.waitIndex(mine, ms, i + 1);
      const f = this.frames[i];
      const encryptLen = Number(tagValue(this.text(f, 'ext'), 'encryptLen') ?? 0);
      const chunk = decryptChunk(this.key!, f.body, encryptLen);
      parts.push(chunk);
      got += chunk.length;
      frames++;
    }
    return { msgId, status: 200, info: first.body, data: Buffer.concat(parts), frames };
  }

  close(): void {
    this.socket.destroy();
  }
}
