// The SDP a DESCRIBE answers, shaped like the model's: the E1 Outdoor Pro and
// the RLC-1224A send no sprop-parameter-sets (no fmtp line for video), the
// CX820 does (measured 2026-11-02). cam-proxy's live relay depends on this
// to reproduce go2rtc's placeholder SPS.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { makeEngine } from './helpers';
import { RtspService, findMediaMtx } from '../src/rtsp/rtsp';
import { shapeSdp } from '../src/rtsp/sdp';
import { RtspSplitter, shapeMessage } from '../src/rtsp/front';

const mediamtx = findMediaMtx();

// As MediaMTX writes it (cam-sim's E1 profile before shaping).
const MTX_SDP = [
  'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=No Name', 'c=IN IP4 0.0.0.0', 't=0 0',
  'm=video 0 RTP/AVP 96', 'a=control:trackID=0', 'a=rtpmap:96 H264/90000',
  'a=fmtp:96 packetization-mode=1; profile-level-id=42C016; sprop-parameter-sets=Z0LAFtoCgL/lhAAAAwAEAAADAFA8WLqA,aM4PyA==',
  'm=audio 0 RTP/AVP 97', 'a=control:trackID=1', 'a=rtpmap:97 mpeg4-generic/16000/1',
  'a=fmtp:97 config=1408; indexdeltalength=3; indexlength=3; mode=AAC-hbr; profile-level-id=1; sizelength=13; streamtype=5', '',
].join('\r\n');

describe('shapeSdp', () => {
  it('without sprop: the video fmtp line goes, the audio one stays; the tool line after t=', () => {
    const out = shapeSdp(MTX_SDP, { sprop: false, tool: 'Reolink Streaming Media 2024.12.11' }).split('\r\n');
    expect(out.filter((l) => l.startsWith('a=fmtp:'))).toEqual([expect.stringMatching(/^a=fmtp:97 config=1408/)]);
    expect(out[out.indexOf('t=0 0') + 1]).toBe('a=tool:Reolink Streaming Media 2024.12.11');
    expect(out).toContain('a=rtpmap:96 H264/90000');
  });

  it('with sprop and no tool: unchanged', () => {
    expect(shapeSdp(MTX_SDP, { sprop: true })).toBe(MTX_SDP);
  });

  it('drops H.265 sprop-vps/sps/pps too', () => {
    const h265 = MTX_SDP.replace('a=rtpmap:96 H264/90000', 'a=rtpmap:96 H265/90000').replace(/a=fmtp:96 [^\r]*/, 'a=fmtp:96 sprop-pps=RAHAc8GJ; sprop-sps=QgEB; sprop-vps=QAEM');
    expect(shapeSdp(h265, { sprop: false })).not.toMatch(/sprop/);
  });
});

describe('RtspSplitter and shapeMessage', () => {
  it('splits answers and interleaved frames across chunks, and fixes Content-Length after shaping', () => {
    const answer = Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(MTX_SDP)}\r\n\r\n${MTX_SDP}`, 'latin1');
    const frame = Buffer.from([0x24, 0, 0, 3, 1, 2, 3]);
    const all = Buffer.concat([answer, frame]);
    const s = new RtspSplitter();
    const got = [...s.push(all.subarray(0, 50))!, ...s.push(all.subarray(50, all.length - 2))!, ...s.push(all.subarray(all.length - 2))!];
    expect(got.map((m) => m.kind)).toEqual(['text', 'frame']);
    const shaped = shapeMessage(got[0], { sprop: false }).toString('latin1');
    const [head, body] = shaped.split('\r\n\r\n');
    expect(Number(/Content-Length: (\d+)/.exec(head)![1])).toBe(Buffer.byteLength(shaped.slice(head.length + 4)));
    expect(body).not.toMatch(/sprop/);
    expect(shapeMessage(got[1], { sprop: false })).toEqual(frame);
  });

  it('gives up on a head that never ends', () => {
    expect(new RtspSplitter().push(Buffer.alloc(70 * 1024, 0x41))).toBeNull();
  });
});

async function describeSdp(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`DESCRIBE rtsp://127.0.0.1:${port}/${path} RTSP/1.0\r\nCSeq: 1\r\nAuthorization: Basic ${Buffer.from('cams:cams-pw').toString('base64')}\r\nAccept: application/sdp\r\n\r\n`));
    const sp = new RtspSplitter();
    s.on('data', (d: Buffer) => {
      const m = sp.push(d)?.[0];
      if (m && m.kind === 'text') {
        s.destroy();
        resolve(m.body.toString('utf8'));
      }
    });
    s.on('error', reject);
    setTimeout(() => (s.destroy(), reject(new Error('no answer'))), 10_000);
  });
}

const services: RtspService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
});

describe.skipIf(!mediamtx)('the DESCRIBE answer per model', () => {
  async function start(model: string) {
    const engine = await makeEngine({ CAMSIM_MODEL: model });
    const svc = new RtspService(engine, { port: 0, host: '127.0.0.1', mediamtx: mediamtx! });
    services.push(svc);
    await svc.start();
    return svc.port();
  }
  const video = (sdp: string) => sdp.slice(sdp.indexOf('m=video'), sdp.indexOf('m=audio'));

  it('E1 Outdoor Pro: the tool line, and no fmtp line for video (sub and main)', async () => {
    const port = await start('E1-Outdoor-Pro');
    for (const path of ['h264Preview_01_sub', 'h264Preview_01_main']) {
      const sdp = await describeSdp(port, path);
      expect(sdp).toContain('a=tool:Reolink Streaming Media 2024.12.11');
      expect(video(sdp)).toMatch(/a=rtpmap:96 H26[45]\/90000/);
      expect(video(sdp)).not.toMatch(/a=fmtp|sprop/);
    }
  }, 60_000);

  it('RLC-1224A: no sprop-parameter-sets', async () => {
    const port = await start('RLC-1224A');
    expect(video(await describeSdp(port, 'h264Preview_01_sub'))).not.toMatch(/sprop/);
  }, 60_000);

  it('CX820: sprop-parameter-sets as MediaMTX writes them', async () => {
    const port = await start('CX820');
    expect(video(await describeSdp(port, 'h264Preview_01_sub'))).toMatch(/sprop-parameter-sets=/);
  }, 60_000);
});
