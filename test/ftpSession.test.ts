import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'net';
import { makeCamera, makeEngine, post, login } from './helpers';
import { FtpUploader } from '../src/ftp/uploader';

// Issue #25: the FTP session the real RLC-1224A speaks, measured against
// cam-proxy's server on 2026-09-27 (cam-proxy#4). A small FTP server that
// records every command per connection checks the order; ftp-srv (in
// ftp.test.ts) covers TLS and real file writes.

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (closers.length) await closers.pop()!();
});

interface Session { id: number; commands: string[]; stored: Map<string, Buffer> }

// Plain FTP, user "cam" / "pw". Folders exist once made (CWD to a missing
// one answers 550, like most servers). PASV only; EPSV answers 502.
async function recordingServer() {
  const sessions: Session[] = [];
  const events: string[] = []; // across sessions, in order: "<id> <what>"
  const dirs = new Set<string>(['/']);
  const sockets = new Set<net.Socket>();
  let next = 1;
  const server = net.createServer((sock) => {
    sockets.add(sock);
    const s: Session = { id: next++, commands: [], stored: new Map() };
    sessions.push(s);
    events.push(`${s.id} connect`);
    let cwd = '/';
    let pasv: net.Server | undefined;
    let data: Promise<net.Socket> | undefined;
    const reply = (l: string) => sock.write(`${l}\r\n`);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [cmd, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        s.commands.push(cmd === 'PASS' ? 'PASS' : line);
        const path = arg.startsWith('/') ? arg : `${cwd === '/' ? '' : cwd}/${arg}`;
        switch (cmd) {
          case 'USER': reply('331 password'); break;
          case 'PASS': reply(arg === 'pw' ? '230 ok' : '530 no'); break;
          case 'PWD': reply(`257 "${cwd}"`); break;
          case 'CWD':
            if (dirs.has(path)) { cwd = path; reply('250 ok'); } else reply('550 no such folder');
            break;
          case 'MKD': dirs.add(path); reply(`257 "${path}"`); break;
          case 'TYPE': case 'MODE': case 'STRU': case 'OPTS': reply('200 ok'); break;
          case 'EPSV': reply('502 not here'); break;
          case 'PASV': {
            pasv = net.createServer();
            data = new Promise((r) => pasv!.once('connection', (c) => r(c)));
            pasv.listen(0, '127.0.0.1', () => {
              const p = (pasv!.address() as net.AddressInfo).port;
              reply(`227 Entering Passive Mode (127,0,0,1,${p >> 8},${p & 255})`);
            });
            break;
          }
          case 'STOR': {
            const name = arg;
            reply('150 go');
            void data!.then((c) => {
              const chunks: Buffer[] = [];
              c.on('data', (x: Buffer) => chunks.push(x));
              c.on('end', () => {
                s.stored.set(name, Buffer.concat(chunks));
                events.push(`${s.id} stored ${name.split('.').pop()}`);
                pasv?.close();
                reply('226 done');
              });
            });
            break;
          }
          case 'QUIT': reply('221 bye'); sock.end(); break;
          default: reply('502 not here');
        }
      }
    });
    sock.on('error', () => undefined);
    sock.on('close', () => sockets.delete(sock));
    reply('220 recording server');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { port: (server.address() as net.AddressInfo).port, sessions, events };
}

const ftpObject = (engine: Awaited<ReturnType<typeof makeEngine>>, port: number, over: Record<string, unknown> = {}): Record<string, any> => ({
  ...engine.settings.get('Ftp'), server: '127.0.0.1', port, userName: 'cam', password: 'pw', remoteDir: '', autoDir: 1, enable: 1, onlyFtps: 0, ...over,
});

describe('FTP session like the RLC-1224A (#25)', () => {
  it('uploads the clip with the camera’s command sequence: CWD per folder (MKD when missing), PASV only', async () => {
    const s = await recordingServer();
    const engine = await makeEngine({ CAMSIM_NAME: 'Den' });
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, s.port) }, { strictPartial: true });
    const { recording } = engine.events.trigger('motion', 1);
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    const clip = s.sessions.find((x) => [...x.stored.keys()].some((k) => k.endsWith('.mp4')))!;
    const [y, m, d] = recording!.date.split('-');
    // (QUIT follows as the connection closes.)
    expect(clip.commands.filter((c) => c !== 'QUIT')).toEqual([
      'USER cam', 'PASS', 'PWD',
      `CWD ${y}`, `MKD ${y}`, `CWD ${y}`,
      `CWD ${m}`, `MKD ${m}`, `CWD ${m}`,
      `CWD ${d}`, `MKD ${d}`, `CWD ${d}`,
      'TYPE I', 'MODE S', 'PASV', expect.stringMatching(/^STOR Den_00_\d{14}\.mp4$/),
    ]);
    expect(s.sessions.flatMap((x) => x.commands).some((c) => c.startsWith('EPSV'))).toBe(false);
  });

  it('uploads the snapshot in a second session, started while the clip is still uploading', async () => {
    const s = await recordingServer();
    const engine = await makeEngine({ CAMSIM_NAME: 'Den' });
    const up = new FtpUploader(engine);
    closers.push(() => up.stop());
    engine.settings.set('SetFtpV20', { Ftp: ftpObject(engine, s.port) }, { strictPartial: true });
    const { recording } = engine.events.trigger('motion', 1);
    await up.uploadRecording(engine.sd.byId(recording!.id)!);
    expect(s.sessions).toHaveLength(2);
    const [clip, snap] = [s.sessions.find((x) => [...x.stored.keys()].some((k) => k.endsWith('.mp4')))!, s.sessions.find((x) => [...x.stored.keys()].some((k) => k.endsWith('.jpg')))!];
    expect(clip.id).not.toBe(snap.id);
    // The snapshot's session connected before the clip was stored.
    expect(s.events.indexOf(`${snap.id} connect`)).toBeLessThan(s.events.indexOf(`${clip.id} stored mp4`));
    expect(engine.counters.ftpUploads).toBe(1);
  });

  it('TestFtp runs a whole session and stores a .txt, like the camera', async () => {
    const s = await recordingServer();
    const { app, engine } = await makeCamera({ CAMSIM_NAME: 'Den' });
    const t = await login(app);
    const ok = await post(app, 'TestFtp', { Ftp: ftpObject(engine, s.port) }, t);
    expect(ok.reply).toEqual({ cmd: 'TestFtp', code: 0, value: { rspCode: 200 } });
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].commands).toEqual(['USER cam', 'PASS', 'PWD', 'TYPE A', 'MODE S', 'PASV', expect.stringMatching(/^STOR Den_00_\d{14}\.txt$/), 'QUIT']);
    expect([...s.sessions[0].stored.values()][0].length).toBeGreaterThan(0);
  });
});

describe('pre-record (#25)', () => {
  it('starts a triggered recording 4 s before the event when preRec is on', async () => {
    const engine = await makeEngine();
    vi.useFakeTimers({ now: new Date('2026-09-26T11:52:21Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    expect(engine.settings.running.Rec.preRec).toBe(1);
    const { recording } = engine.events.trigger('motion', 1);
    expect(recording!.start).toBe('065217'); // 06:52:21 CDT − 4 s
    expect(recording!.picture).toBe('20260926065221'); // the picture: the event itself
    vi.advanceTimersByTime(60_000);
    engine.settings.running.Rec.preRec = 0;
    const { recording: r2 } = engine.events.trigger('motion', 1);
    expect(r2!.start).toBe('065321');
    expect(r2!.picture).toBe('20260926065321');
  });
});
