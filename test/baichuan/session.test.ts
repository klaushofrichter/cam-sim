import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import { startBc, closeAll, until, sleep } from './harness';
import { downloadXml, loginXml, logoutXml, stopXml } from './client';
import { readTrace } from './trace';
import { CLS_CLIENT, CLS_NONCE_REQUEST, ENC_CHOICE, ENC_OFFER, encodeFrame, encodeHeader } from '../../src/baichuan/frame';
import { bcXor, md5_31 } from '../../src/baichuan/cipher';
import { LINK_TYPE_XML, LOGIN_ERR_XML } from '../../src/baichuan/xml';
import { createCameraApp } from '../../src/camera-api/app';
import { createLogger } from '../../src/log';
import { login, post } from '../helpers';

afterEach(closeAll);
const hex = (s: string) => Buffer.from(s.replace(/ /g, ''), 'hex');

describe('the test client sends what the traces show', () => {
  it('login, download, stop and logout XML', () => {
    const sent = (file: string, cmd: number) => readTrace(file).filter((m) => m.dir === 'in' && m.cmd === cmd);
    expect(loginXml('REDACTED-USER-HASH', 'REDACTED')).toBe(sent('login-admin.txt', 1)[1].xml);
    const id = '/mnt/sda/Mp4Record/2026-10-02/RecS0A_DST20261002_040758_040819_0_55148080000000_7224E.mp4';
    expect(downloadXml(id)).toBe(sent('vod-nosearch.txt', 8)[0].xml);
    expect(downloadXml(id, '0120261002040758')).toBe(sent('vod-nosearch.txt', 8)[1].xml);
    expect(stopXml()).toBe(sent('vod-sub.txt', 9)[0].xml);
    expect(logoutXml('admin', 'REDACTED')).toBe(sent('login-admin.txt', 2)[0].xml);
  });
});

describe('Baichuan server: login', () => {
  it('answers the nonce and an admin login with the traced headers (login-admin.txt)', async () => {
    const { connect, engine } = await startBc();
    const c = await connect();
    await c.nonceRequest();
    expect(encodeHeader(c.frames[0].header)).toEqual(hex('f0 de bc 0a 01 00 00 00 37 01 00 00 fa 01 00 00 12 dd 14 66'));
    expect(c.nonce).toMatch(/^[0-9A-F]{29}$/);
    const r = await c.login('admin', 'admin-pw');
    expect(encodeHeader(r.header)).toEqual(hex('f0 de bc 0a 01 00 00 00 10 14 00 00 fa 02 00 00 c8 00 00 00 00 00 00 00'));
    const xml = c.text(r);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<DeviceInfo version="1.1">');
    expect(xml).not.toContain('REDACTED');
    expect(engine.counters.baichuanLogins).toBe(1);
    expect(engine.counters.baichuanSessions).toBe(1);
  });

  it('logs in proxy and a guest user too', async () => {
    const { loggedIn, engine } = await startBc();
    await loggedIn('proxy', 'proxy-pw');
    await loggedIn('viewer', 'viewer-pw');
    expect(engine.counters.baichuanLogins).toBe(2);
  });

  it('answers a wrong password with 401 and remainTimes 10; a correct login can follow (err-badpass.txt)', async () => {
    const { connect, engine } = await startBc();
    const c = await connect();
    const bad = await c.login('admin', 'wrong');
    expect(encodeHeader(bad.header)).toEqual(hex('f0 de bc 0a 01 00 00 00 82 00 00 00 fa 02 00 00 91 01 00 00 00 00 00 00'));
    expect(c.text(bad)).toBe(LOGIN_ERR_XML);
    expect(c.closed).toBe(false);
    expect((await c.login('admin', 'admin-pw')).header.status).toBe(200);
    expect(engine.counters.baichuanLogins).toBe(1);
  });

  it('baichuan.loginFail answers 401 for the next count logins', async () => {
    const { connect, engine } = await startBc();
    engine.faults.set({ name: 'baichuan.loginFail', count: 1 });
    const c = await connect();
    expect((await c.login('proxy', 'proxy-pw')).header.status).toBe(401);
    expect((await c.login('proxy', 'proxy-pw')).header.status).toBe(200);
    expect(engine.faults.active('baichuan.loginFail')).toBeUndefined();
  });

  // Review Focus 4.
  it('uses the current users: a changed password and a new user apply to the next login', async () => {
    const { connect, engine } = await startBc();
    expect(engine.sessions.modifyUser('proxy', { password: 'new-pw' })).toBeNull();
    expect(engine.sessions.addUser({ name: 'extra', level: 'guest', password: 'extra-pw' })).toBeNull();
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(401);
    expect((await (await connect()).login('proxy', 'new-pw')).header.status).toBe(200);
    expect((await (await connect()).login('extra', 'extra-pw')).header.status).toBe(200);
  });

  it('reads a request split into single bytes', async () => {
    const { connect } = await startBc();
    const c = await connect();
    for (const b of encodeFrame({ cmd: 1, msgId: 0x01fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST })) {
      c.write(Buffer.from([b]));
      await sleep(1);
    }
    expect((await c.waitFor((f) => f.header.cmd === 1)).header.status).toBe(ENC_CHOICE);
  });
});

describe('Baichuan server: protocol errors close without a reply (err-protocol.txt)', () => {
  const closedSilently = async (c: { ended: Promise<string>; frames: unknown[] }) => {
    expect(['eof', 'reset']).toContain(await c.ended);
    expect(c.frames).toHaveLength(0);
  };

  it('a request before login', async () => {
    const { connect } = await startBc();
    const c = await connect();
    c.write(encodeFrame({ cmd: 8, msgId: 0x01fa, status: 0, cls: CLS_CLIENT, body: bcXor(Buffer.from(downloadXml('/mnt/sda/Mp4Record/2026-10-02/nothing.mp4')), 250) }));
    await closedSilently(c);
  });

  it('a login before the nonce request', async () => {
    const { connect } = await startBc();
    const c = await connect();
    c.write(encodeFrame({ cmd: 1, msgId: 0x01fa, status: 0, cls: CLS_CLIENT, body: bcXor(Buffer.from(loginXml('A', 'B')), 250) }));
    await closedSilently(c);
  });

  it('bad magic', async () => {
    const { connect } = await startBc();
    const c = await connect();
    c.write(Buffer.alloc(24, 0x55));
    await closedSilently(c);
  });

  // Review Focus 5.
  it('a declared body far beyond any real message closes at once, without buffering', async () => {
    const { connect, server } = await startBc();
    const c = await connect();
    c.write(encodeHeader({ cmd: 1, bodyLen: 0x7fffffff, msgId: 0x01fa, status: 0, cls: CLS_CLIENT, payloadOffset: 0 }));
    await closedSilently(c);
    await until(() => server.connectionCount() === 0);
  });
});

describe('Baichuan server: commands after login', () => {
  it('an unknown cmd answers 405 and the session stays usable; cmd 93 answers LinkType (err-protocol.txt, idle.txt)', async () => {
    const { loggedIn } = await startBc();
    const c = await loggedIn();
    const r405 = await c.call(4000);
    expect(encodeHeader(r405.header)).toEqual(hex('f0 de bc 0a a0 0f 00 00 00 00 00 00 fa 03 00 00 95 01 00 00 00 00 00 00'));
    const link = await c.call(93);
    expect(link.header).toMatchObject({ status: 200, bodyLen: 109, msgId: 0x04fa, payloadOffset: 0 });
    expect(c.text(link)).toBe(LINK_TYPE_XML);
  });

  it('logout answers 200 with no body, then closes; the session leaves GetOnline', async () => {
    const { loggedIn, engine } = await startBc();
    const c = await loggedIn('proxy', 'proxy-pw');
    expect(engine.sessions.online().map((u) => u.userName)).toEqual(['proxy']);
    const r = await c.call(2, logoutXml('proxy', 'proxy-pw'));
    expect(r.header).toMatchObject({ status: 200, bodyLen: 0 });
    expect(await c.ended).toBe('eof');
    await until(() => engine.sessions.online().length === 0);
    expect(engine.counters.baichuanSessions).toBe(0);
  });

  it('HTTP GetOnline lists open Baichuan sessions; a plain close removes them', async () => {
    const { loggedIn, engine } = await startBc();
    const cam = createCameraApp(engine, { port: 'http' });
    const t = await login(cam);
    const c = await loggedIn('proxy', 'proxy-pw');
    const users = (await post(cam, 'GetOnline', {}, t)).reply.value.User;
    const bc = users.find((u: { userName: string }) => u.userName === 'proxy');
    expect(bc).toMatchObject({ canbeDisconn: 0, level: 'admin' });
    expect(bc.ip).toMatch(/127\.0\.0\.1$/);
    expect(bc.sessionId).toBeGreaterThan(users.find((u: { userName: string }) => u.userName === 'cams').sessionId);
    c.close();
    await until(() => !engine.sessions.online().some((u) => u.userName === 'proxy'));
    expect((await post(cam, 'GetOnline', {}, t)).reply.value.User.map((u: { userName: string }) => u.userName)).toEqual(['cams']);
  });
});

describe('Baichuan server: request log and secrets', () => {
  it('records cmd, status and lengths; no password, nonce, hash or key at any log level', async () => {
    let out = '';
    const log = createLogger('trace', new Writable({ write(chunk, _e, cb) { out += chunk; cb(); } }));
    const { loggedIn, engine } = await startBc({ log });
    const c = await loggedIn('proxy', 'proxy-pw');
    await c.call(93);
    await c.call(4000);
    await c.call(2, logoutXml('proxy', 'proxy-pw'));
    await c.ended;
    const recs = engine.requests.recent(50).filter((r) => r.port === 'baichuan').reverse();
    expect(recs.map((r) => [r.cmd, r.status])).toEqual([['1', 200], ['1', 200], ['93', 200], ['4000', 405], ['2', 200]]);
    expect(recs[0]).toMatchObject({ method: 'BC', path: '', len: 0, replyLen: 311 });
    expect(recs[1]).toMatchObject({ len: 296, replyLen: 5136 });
    expect(recs[2]).toMatchObject({ len: 0, replyLen: 109 });
    expect(out).toContain('camera_request');
    const nonce = c.nonce!;
    const text = out + JSON.stringify(recs);
    for (const secret of ['proxy-pw', nonce, md5_31(`proxy${nonce}`), md5_31(`proxy-pw${nonce}`), c.key!.toString('ascii')]) {
      expect(text).not.toContain(secret);
    }
  });
});
