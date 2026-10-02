import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { readTrace, TRACE_DIR } from './trace';
import { decodeHeader, encodeHeader } from '../../src/baichuan/frame';
import { LOGIN_REPLY_LINES } from '../../src/baichuan/device-info';
import { EXT_BINARY, EXT_CHUNK, LINK_TYPE_XML, LOGIN_ERR_XML, PUSHES, fileInfoXml, loginReplyXml, nonceXml, tagValue } from '../../src/baichuan/xml';
import { chunkSizes, infoRecord } from '../../src/baichuan/records';

const camera = (file: string, cmd: number) => readTrace(file).filter((m) => m.dir === 'out' && m.cmd === cmd);
const len = (m: { header: Buffer }) => decodeHeader(m.header).bodyLen;
const hex = (s: string) => s.replace(/ /g, '');

describe('the traces (reference/rlc-1224a/baichuan)', () => {
  it('every traced header re-encodes to the same bytes', () => {
    const files = readdirSync(TRACE_DIR).filter((f) => f.endsWith('.txt'));
    expect(files).toHaveLength(13);
    let n = 0;
    for (const f of files) {
      for (const m of readTrace(f)) {
        expect(encodeHeader(decodeHeader(m.header)), `${f} cmd ${m.cmd}`).toEqual(m.header);
        n++;
      }
    }
    expect(n).toBeGreaterThan(1600);
  });

  it('the nonce reply, nonce aside: 311 bytes with a 29-character nonce', () => {
    const [m] = camera('login-admin.txt', 1);
    expect(nonceXml('REDACTED')).toBe(m.xml);
    expect(Buffer.byteLength(nonceXml('N'.repeat(29)))).toBe(len(m));
  });

  it('the login reply, secrets aside: 5136 bytes with two 16-character secrets', () => {
    const m = camera('login-admin.txt', 1)[1];
    expect(LOGIN_REPLY_LINES).toHaveLength(192);
    expect(loginReplyXml('REDACTED', 'REDACTED')).toBe(m.xml);
    expect(camera('login-proxy.txt', 1)[1].xml).toBe(m.xml);
    expect(Buffer.byteLength(loginReplyXml('A'.repeat(16), 'B'.repeat(16)))).toBe(len(m));
  });

  it('the 401 body and LinkType', () => {
    const bad = camera('err-badpass.txt', 1).find((m) => decodeHeader(m.header).status === 401)!;
    expect(LOGIN_ERR_XML).toBe(bad.xml);
    expect(Buffer.byteLength(LOGIN_ERR_XML)).toBe(len(bad));
    const link = camera('idle.txt', 93)[0];
    expect(LINK_TYPE_XML).toBe(link.xml);
    expect(Buffer.byteLength(LINK_TYPE_XML)).toBe(len(link));
  });

  it('the eight pushes: cmds, XML, lengths, and 0.04-0.5 s after login', () => {
    const traced = readTrace('idle.txt').filter((m) => m.dir === 'out' && decodeHeader(m.header).msgId === 0 && m.xml);
    expect(PUSHES.map((p) => p.cmd)).toEqual([78, 79, 464, 547, 291, 677, 600, 669]);
    for (const p of PUSHES) {
      const m = traced.find((x) => x.cmd === p.cmd)!;
      expect(p.xml, `cmd ${p.cmd}`).toBe(m.xml);
      expect(Buffer.byteLength(p.xml)).toBe(len(m));
      expect(p.afterMs).toBeGreaterThanOrEqual(40);
      expect(p.afterMs).toBeLessThanOrEqual(500);
    }
  });

  it('the cmd-8 extensions: 106 and 136 bytes', () => {
    const frames = camera('vod-sub.txt', 8);
    expect(EXT_BINARY).toBe(frames[0].xml);
    expect(Buffer.byteLength(EXT_BINARY)).toBe(decodeHeader(frames[0].header).payloadOffset);
    expect(EXT_CHUNK).toBe(frames[1].xml);
    expect(Buffer.byteLength(EXT_CHUNK)).toBe(decodeHeader(frames[1].header).payloadOffset);
  });

  it('cmd 13 replies (fileinfo.txt)', () => {
    const start = { year: 2026, month: 10, day: 2, hour: 4, minute: 7, second: 58 };
    const end = { ...start, minute: 8, second: 19 };
    const r = camera('fileinfo.txt', 13);
    expect(fileInfoXml({ name: '0120261002040758', size: 6716462, start, end })).toBe(r[0].xml);
    expect(fileInfoXml({ name: '', size: 467534, start, end })).toBe(r[1].xml);
    expect(fileInfoXml({ name: '', size: 6716462, start, end })).toBe(r[3].xml);
    expect(r.map(len).slice(0, 4)).toEqual([605, 588, 605, 589]);
  });

  it('the 32-byte info record (vod-sub.txt, abort.txt)', () => {
    const sub = infoRecord({ width: 896, height: 512, fps: 10, main: false,
      start: { year: 2026, month: 10, day: 2, hour: 4, minute: 7, second: 58 }, end: { year: 2026, month: 10, day: 2, hour: 4, minute: 8, second: 19 } });
    expect(sub.toString('hex')).toBe(hex('31 30 30 32 20 00 00 00 80 03 00 00 00 02 00 00 00 0a 7e 0a 02 04 07 3a 7e 0a 02 04 08 13 00 00'));
    const main = infoRecord({ width: 4512, height: 2512, fps: 20, main: true,
      start: { year: 2026, month: 10, day: 2, hour: 5, minute: 33, second: 20 }, end: { year: 2026, month: 10, day: 2, hour: 5, minute: 33, second: 41 } });
    expect(main.toString('hex')).toBe(hex('31 30 30 32 20 00 00 00 a0 11 00 00 d0 09 00 00 00 14 7e 0a 02 05 21 14 7e 0a 02 05 21 29 01 00'));
  });

  it('chunk sizes: 39,400 three times, then 12,872, repeating; the last is shorter', () => {
    const sub = chunkSizes(467534); // vod-sub.txt: 14 frames
    expect(sub).toHaveLength(14);
    expect(sub.slice(0, 6)).toEqual([39400, 39400, 39400, 12872, 39400, 39400]);
    expect(sub.slice(-3)).toEqual([12872, 39400, 34918]);
    const main = chunkSizes(6716462); // vod-main.txt: 205 frames
    expect(main).toHaveLength(205);
    expect(main.slice(-3)).toEqual([39400, 12872, 31790]);
    expect(chunkSizes(6548762).slice(-3)).toEqual([39400, 39400, 8034]); // abort.txt
    expect(chunkSizes(460940).slice(-3)).toEqual([12872, 39400, 28324]);
    expect(chunkSizes(500)).toEqual([500]);
  });

  it('tagValue reads one tag and not a longer one ending in the same name', () => {
    const xml = '<a><userName>u</userName><name>n</name><empty></empty></a>';
    expect(tagValue(xml, 'name')).toBe('n');
    expect(tagValue(xml, 'userName')).toBe('u');
    expect(tagValue(xml, 'empty')).toBe('');
    expect(tagValue(xml, 'missing')).toBeUndefined();
  });
});
