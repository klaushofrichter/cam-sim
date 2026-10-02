# Baichuan Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cam-sim answers Reolink's Baichuan protocol on TCP 9000 (login, recordings download, stop, file info, LinkType, logout) the way the real RLC-1224A does, so cam-proxy's new Baichuan client can be tested against it.

**Architecture:**
- A new `src/baichuan/` module, written fresh for cam-sim from reolink_aio and its PR #186 (both MIT):
  - `frame.ts`: the header codec and a streaming parser.
  - `cipher.ts`: the XOR, AES-128-CFB and partial chunk encryption.
  - `xml.ts` and the generated `device-info.ts`: the reply bodies, copied line by line from the traces.
  - `records.ts`: the 32-byte info record and the chunk sizes.
  - `vod.ts`: the file behind an `<Id>`, cmd 13, and a cmd-8 transfer with backpressure.
  - `server.ts`: connections, login, the session limit, idle timers, pushes and the command dispatch.
- The engine gets small hooks:
  - a Baichuan session registry in `Sessions`, so the sessions show in `GetOnline`;
  - five faults and `FaultSpec.max`;
  - four counters;
  - a `baichuan` hook, so `reboot`, `power-off` and `downloads.dropActive` reach port 9000.
- `createCamSim().listen()` opens the port: 9000 from the CLI, a free port in process unless one is named.

**Tech Stack:** Node 26, TypeScript (strict, nodenext/commonjs), `node:net`, `node:crypto`, `node:fs/promises`, Express 5 (existing HTTP API), Vitest, Svelte 5, Playwright, Docker. No new dependency.

**Spec:**
- `docs/superpowers/specs/2026-10-02-baichuan-server-design.md`: cam-sim's part, the authority.
- The shared protocol design is cam-proxy's `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md` ("Protocol summary"; cam-proxy repo, branch `docs/baichuan-spec`).
- The measured traces are in `reference/rlc-1224a/baichuan/` (README plus 13 scenario files).

## Global Constraints

- **Port:** `CAMSIM_BAICHUAN_PORT`, default 9000 (`0` picks a free port, for tests). It joins `ports` in `src/config.ts` and the README's "Ports and services" table. In process (`createCamSim`), an unnamed `baichuan` port is a free port.
- **Code:**
  - Everything lives in `src/baichuan/`, written fresh for cam-sim from reolink_aio `5d37cb3` and PR #186 `9a1bb52` (MIT).
  - File headers say so, and `THIRD_PARTY_NOTICES` carries reolink_aio's MIT notice.
  - Nothing comes from Neolink (AGPL-3.0), and no code is shared with cam-proxy.
- **Dependencies:** only `node:net`, `node:crypto` and `node:fs/promises`.
- **Framing (measured):**
  - The client sends class `14 65` (nonce request, 20-byte header) and `14 64` (everything else, 24 bytes).
  - Every reply and push is class `00 00` with a 24-byte header, except the nonce reply: `14 66`, 20 bytes, bytes 16–17 `12 dd`.
  - Replies echo the request's message id and channel byte.
- **Mirror the real camera:** copy reply XML, status codes and framing from the traces. Don't invent unmeasured behaviour. Where phase 0 left a case unmeasured, do the simplest thing the traces allow, and list it in the README's "What differs from the real camera".
- **Ciphers:** pinned by unit tests to known bytes (reolink_aio as the oracle, with test values only) and to the traces. That way cam-sim and cam-proxy can't agree on a wrong cipher.
- **Measured limits:**
  - 12 TCP connections on port 9000, counting connections that never logged in. The 13th is accepted, then reset at its first message with no reply.
  - Idle closes: 32 s after the client's last message, 12.5 s for a connection that never sends.
  - Both timeouts are constants in `src/config.ts`, so tests can shorten them.
- **No media bytes in the repo:** tests use the sim's own recordings (the generated fixtures, through `SdCard`).
- **No secrets in logs:** the server never logs a password, a nonce, a key or a message body. The request log holds the cmd, the status and the lengths only.
- **Faults:**
  - Baichuan faults never touch the HTTP API, and `downloads.refuse` stays HTTP only.
  - Baichuan transfers are independent of HTTP Download and of `activeDownloads`.
  - As `CLAUDE.md` requires, the README fault table, the Simulator page labels and the CHANGELOG change together, all in this branch.
- **Repo rules:**
  - Every test server binds `127.0.0.1`.
  - Never source `.env`.
  - Stage files explicitly.
  - Commits end with the attribution trailer lines your session's instructions require.

## Review Focus

These are the inputs most likely to bite a person using this. The spec implies them, but its test list doesn't exercise them. Each one is pinned by a test in the task named.

1. **Existing callers of `sim.listen({http:0, https:0, control:0, rtsp:0, onvif:0})` that don't name `baichuan`.** These are cams' and cam-proxy's suites, and cams-compat CI runs them in parallel workers. They must not collide on 9000: the in-process default is a free port, and `listen()` returns it. Pinned in Task 7.
2. **`sim.close()` while Baichuan connections and a transfer are open.** `net.Server.close()` waits for every connection, so close must end them and resolve promptly. A test runner must not hang. Pinned in Task 7.
3. **A client that vanishes while its transfer waits for `drain`.** The transfer ends, the session leaves `GetOnline`, the counters return to 0, and nothing is left pending or unhandled. Pinned in Task 6.
4. **A password changed or a user added through the camera API (`ModifyUser`, `AddUser`).** The next Baichuan login uses the current users, like HTTP Login. Pinned in Task 5.
5. **A frame that declares a huge body (e.g. `0x7fffffff` bytes).** The connection closes at once, without buffering toward that length. Pinned in Task 1 (parser) and Task 5 (server).

---

## Before you start

The plan, the spec and the traces must be on `main` (the `docs/baichuan-spec` PR merged). Then:

```bash
cd ~/Development/cam-sim
git checkout main && git pull
git checkout -b feat/baichuan-server
ls reference/rlc-1224a/baichuan/   # README.md and 13 .txt traces
npm ci && npx vitest run            # green before any change
```

## File structure

| File | Responsibility |
|---|---|
| `src/baichuan/frame.ts` (create) | Constants (magic, classes, offer/choice, host channel, `MAX_BODY`); `encodeHeader`, `decodeHeader`, `encodeFrame`; `FrameParser` (split and merged reads; throws `FrameError`) |
| `src/baichuan/cipher.ts` (create) | `XML_KEY`, `AES_IV`, `md5_31`, `bcXor`, `aesKey`, `aesEncrypt`/`aesDecrypt`, `encryptChunk`/`decryptChunk` |
| `THIRD_PARTY_NOTICES` (create) | reolink_aio's MIT notice and the pinned commits |
| `src/baichuan/device-info.ts` (create, generated) | `LOGIN_REPLY_LINES`: the traced login reply, line by line |
| `src/baichuan/xml.ts` (create) | Reply bodies (nonce, login reply, 401, LinkType, extensions, pushes, cmd-13 file info) and `tagValue` |
| `src/baichuan/records.ts` (create) | `infoRecord` (the 32-byte record) and `chunkSize`/`chunkSizes` |
| `src/baichuan/vod.ts` (create) | `resolveFile`, `timesOf`, `fileInfoReply`, `Transfer` |
| `src/baichuan/server.ts` (create) | `BaichuanServer`: connections, login, limit, idle, pushes, dispatch, request log, device state |
| `src/config.ts` (modify) | `ports.baichuan`, `baichuan` timeouts, the three measured constants |
| `src/engine/faults.ts` (modify) | Five `baichuan.*` faults, `FaultSpec.max` |
| `src/engine/counters.ts` (modify) | `baichuanSessions`, `baichuanLogins`, `baichuanDownloads`, `droppedBaichuanDownloads` |
| `src/engine/sessions.ts` (modify) | Baichuan session registry in `online()`; `findUser`; `count()` stays HTTP only |
| `src/engine/engine.ts` (modify) | `RequestRecord` (port `baichuan`, `len`, `replyLen`); the `baichuan` hook in `reboot`, `powerOff`, `dropDownloads` |
| `src/index.ts` (modify) | `CamSimOptions.baichuan`, `configFromOptions`, `Ports.baichuan`, start and stop the server |
| `Dockerfile`, `compose.yaml`, `scripts/container-smoke.sh`, `e2e/env.ts`, `package.json` (modify) | Expose 9000, map it, smoke-test a login, a fixed e2e port, ship the notice |
| `web/src/pages/Simulator.svelte`, `web/src/lib/state.ts` (modify) | Fault labels, the `max` input |
| `openapi.yaml`, `README.md`, `llms.txt`, `CHANGELOG.md` (modify) | Docs |
| `test/baichuan/*.test.ts`, `test/baichuan/{trace,client,harness}.ts` (create) | Unit, trace, server and VOD tests; a trace reader; a minimal test client; a test harness |
| `test/config.test.ts`, `test/faults.test.ts`, `test/sessions.test.ts`, `test/index.test.ts`, `test/cli.test.ts`, `e2e/settings-simulator.spec.ts` (modify) | Tests for the touched existing modules |

---

### Task 1: Frame codec

**Files:**
- Create: `src/baichuan/frame.ts`
- Test: `test/baichuan/frame.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all from `src/baichuan/frame.ts`):
  - `MAGIC: Buffer`, `CLS_NONCE_REQUEST = 0x1465`, `CLS_NONCE_REPLY = 0x1466`, `CLS_CLIENT = 0x1464`, `CLS_CAMERA = 0x0000`, `ENC_OFFER = 0xdc12`, `ENC_CHOICE = 0xdd12`, `HOST_CHANNEL = 250`, `MAX_BODY = 1048576`.
  - `interface BcHeader { cmd: number; bodyLen: number; msgId: number; status: number; cls: number; payloadOffset: number; size: 20 | 24 }`
  - `interface BcFrame { header: BcHeader; ext: Buffer; body: Buffer }`
  - `class FrameError extends Error`
  - `headerSize(cls: number): 20 | 24 | undefined`
  - `channelOf(msgId: number): number`
  - `encodeHeader(h: Omit<BcHeader, 'size'>): Buffer`
  - `decodeHeader(b: Buffer): BcHeader`
  - `encodeFrame(f: { cmd: number; msgId: number; status: number; cls: number; ext?: Buffer; body?: Buffer }): Buffer`
  - `class FrameParser { constructor(maxBody?: number); push(chunk: Buffer): BcFrame[] }`

- [ ] **Step 1: Write the failing test**

`test/baichuan/frame.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CLS_CAMERA, CLS_CLIENT, CLS_NONCE_REPLY, CLS_NONCE_REQUEST, ENC_CHOICE, ENC_OFFER,
  FrameError, FrameParser, decodeHeader, encodeFrame, encodeHeader, headerSize, type BcHeader,
} from '../../src/baichuan/frame';

const hex = (s: string) => Buffer.from(s.replace(/ /g, ''), 'hex');

// Header bytes copied from reference/rlc-1224a/baichuan/ (the file in each line).
const TRACED: Array<{ what: string; h: Omit<BcHeader, 'size'>; bytes: string }> = [
  { what: 'nonce request (login-admin.txt)', h: { cmd: 1, bodyLen: 0, msgId: 0x01fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 00 00 00 00 fa 01 00 00 12 dc 14 65' },
  { what: 'nonce reply (login-admin.txt)', h: { cmd: 1, bodyLen: 311, msgId: 0x01fa, status: ENC_CHOICE, cls: CLS_NONCE_REPLY, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 37 01 00 00 fa 01 00 00 12 dd 14 66' },
  { what: 'login (login-admin.txt)', h: { cmd: 1, bodyLen: 296, msgId: 0x02fa, status: 0, cls: CLS_CLIENT, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 28 01 00 00 fa 02 00 00 00 00 14 64 00 00 00 00' },
  { what: 'login 200 (login-admin.txt)', h: { cmd: 1, bodyLen: 5136, msgId: 0x02fa, status: 200, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 10 14 00 00 fa 02 00 00 c8 00 00 00 00 00 00 00' },
  { what: 'login 401 (err-badpass.txt)', h: { cmd: 1, bodyLen: 130, msgId: 0x02fa, status: 401, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 01 00 00 00 82 00 00 00 fa 02 00 00 91 01 00 00 00 00 00 00' },
  { what: 'cmd 8 first reply (vod-sub.txt)', h: { cmd: 8, bodyLen: 138, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, payloadOffset: 106 }, bytes: 'f0 de bc 0a 08 00 00 00 8a 00 00 00 fa 07 00 00 c8 00 00 00 6a 00 00 00' },
  { what: 'cmd 8 chunk (vod-sub.txt)', h: { cmd: 8, bodyLen: 39536, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, payloadOffset: 136 }, bytes: 'f0 de bc 0a 08 00 00 00 70 9a 00 00 fa 07 00 00 c8 00 00 00 88 00 00 00' },
  { what: 'cmd 8 not found (err-notfound.txt)', h: { cmd: 8, bodyLen: 0, msgId: 0x04fa, status: 400, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 08 00 00 00 00 00 00 00 fa 04 00 00 90 01 00 00 00 00 00 00' },
  { what: 'push 78 (idle.txt)', h: { cmd: 78, bodyLen: 211, msgId: 0, status: 200, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a 4e 00 00 00 d3 00 00 00 00 00 00 00 c8 00 00 00 00 00 00 00' },
  { what: 'unknown cmd 405 (err-protocol.txt)', h: { cmd: 4000, bodyLen: 0, msgId: 0x03fa, status: 405, cls: CLS_CAMERA, payloadOffset: 0 }, bytes: 'f0 de bc 0a a0 0f 00 00 00 00 00 00 fa 03 00 00 95 01 00 00 00 00 00 00' },
];

describe('Baichuan frame codec', () => {
  it('encodes the traced headers byte for byte and decodes them back', () => {
    for (const t of TRACED) {
      const b = hex(t.bytes);
      expect(encodeHeader(t.h), t.what).toEqual(b);
      expect(decodeHeader(b), t.what).toEqual({ ...t.h, size: b.length });
    }
  });

  it('takes the header size from the class', () => {
    expect(headerSize(CLS_NONCE_REQUEST)).toBe(20);
    expect(headerSize(CLS_NONCE_REPLY)).toBe(20);
    expect(headerSize(CLS_CLIENT)).toBe(24);
    expect(headerSize(CLS_CAMERA)).toBe(24);
    expect(headerSize(0x6482)).toBeUndefined();
  });

  it('encodes a frame as header, extension, body; the length covers both', () => {
    const f = encodeFrame({ cmd: 8, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, ext: Buffer.alloc(106, 1), body: Buffer.alloc(32, 2) });
    expect(f.subarray(0, 24)).toEqual(hex(TRACED[5].bytes));
    expect(f.length).toBe(24 + 138);
  });

  it('refuses an extension on a 20-byte header and an unknown class', () => {
    expect(() => encodeFrame({ cmd: 1, msgId: 0x01fa, status: 0, cls: CLS_NONCE_REQUEST, ext: Buffer.alloc(1) })).toThrow(FrameError);
    expect(() => encodeFrame({ cmd: 1, msgId: 0x01fa, status: 0, cls: 0x6482 })).toThrow(/unknown class/);
  });

  it('parses messages split into single bytes', () => {
    const a = encodeFrame({ cmd: 1, msgId: 0x01fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST });
    const b = encodeFrame({ cmd: 93, msgId: 0x03fa, status: 0, cls: CLS_CLIENT, body: Buffer.from('hello') });
    const p = new FrameParser();
    const out = [];
    for (const byte of Buffer.concat([a, b])) out.push(...p.push(Buffer.from([byte])));
    expect(out.map((f) => [f.header.cmd, f.header.size, f.body.toString()])).toEqual([[1, 20, ''], [93, 24, 'hello']]);
  });

  it('parses several messages in one read, extension and body apart', () => {
    const one = encodeFrame({ cmd: 8, msgId: 0x07fa, status: 200, cls: CLS_CAMERA, ext: Buffer.from('EXT'), body: Buffer.from('BODY') });
    const two = encodeFrame({ cmd: 78, msgId: 0, status: 200, cls: CLS_CAMERA, body: Buffer.from('PUSH') });
    const out = new FrameParser().push(Buffer.concat([one, two, one.subarray(0, 10)]));
    expect(out.map((f) => [f.header.cmd, f.ext.toString(), f.body.toString()])).toEqual([[8, 'EXT', 'BODY'], [78, '', 'PUSH']]);
  });

  it('throws on bad magic, an unknown class, an oversized body and an extension past the body', () => {
    expect(() => new FrameParser().push(Buffer.alloc(24))).toThrow(/bad magic/);
    const unknown = encodeFrame({ cmd: 1, msgId: 0x02fa, status: 0, cls: CLS_CLIENT });
    unknown.writeUInt16BE(0x6482, 18);
    expect(() => new FrameParser().push(unknown)).toThrow(/unknown class/);
    // Review Focus 5: a declared length far beyond any client message.
    const big = encodeHeader({ cmd: 1, bodyLen: 0x7fffffff, msgId: 0x02fa, status: 0, cls: CLS_CLIENT, payloadOffset: 0 });
    expect(() => new FrameParser().push(big)).toThrow(/too long/);
    const past = encodeHeader({ cmd: 1, bodyLen: 4, msgId: 0x02fa, status: 0, cls: CLS_CLIENT, payloadOffset: 8 });
    expect(() => new FrameParser().push(past)).toThrow(/extension/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/baichuan/frame.test.ts`
Expected: FAIL with "Cannot find module '../../src/baichuan/frame'" (or "Failed to load url").

- [ ] **Step 3: Implement**

`src/baichuan/frame.ts`:

```ts
// Baichuan framing (the camera's TCP port 9000): the header codec and a
// streaming parser. Written for cam-sim after reolink_aio 5d37cb3
// (baichuan/base_protocol.py L321-L375, util.py) and its PR #186 9a1bb52,
// both MIT (see THIRD_PARTY_NOTICES). Layout and classes as measured on the
// RLC-1224A: reference/rlc-1224a/baichuan/README.md.

export const MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);

// Message classes: header bytes 18-19, read big-endian.
export const CLS_NONCE_REQUEST = 0x1465; // client, 20-byte header
export const CLS_NONCE_REPLY = 0x1466; // camera, 20-byte header
export const CLS_CLIENT = 0x1464; // client, 24-byte header
export const CLS_CAMERA = 0x0000; // every other camera reply and push, 24-byte header

// Header bytes 16-17 as u16 LE: a reply's status (200 = c8 00), or the
// nonce exchange's encryption offer (12 dc) and choice (12 dd).
export const ENC_OFFER = 0xdc12;
export const ENC_CHOICE = 0xdd12;

// Byte 12, the channel byte: 250 is the host. It is also the XOR offset.
export const HOST_CHANNEL = 250;

// No client message comes near this; a larger declared length isn't a client.
export const MAX_BODY = 1024 * 1024;

export interface BcHeader {
  cmd: number;
  bodyLen: number; // everything after the header: extension + body
  msgId: number; // bytes 12-15 as u32 LE: the channel byte, then a 24-bit counter
  status: number; // bytes 16-17 as u16 LE
  cls: number;
  payloadOffset: number; // the extension's length (24-byte headers; 0 otherwise)
  size: 20 | 24;
}

export interface BcFrame {
  header: BcHeader;
  ext: Buffer;
  body: Buffer;
}

export class FrameError extends Error {}

export function headerSize(cls: number): 20 | 24 | undefined {
  if (cls === CLS_NONCE_REQUEST || cls === CLS_NONCE_REPLY) return 20;
  if (cls === CLS_CLIENT || cls === CLS_CAMERA) return 24;
  return undefined;
}

export const channelOf = (msgId: number): number => msgId & 0xff;

export function encodeHeader(h: Omit<BcHeader, 'size'>): Buffer {
  const size = headerSize(h.cls);
  if (!size) throw new FrameError(`unknown class ${h.cls.toString(16)}`);
  if (size === 20 && h.payloadOffset) throw new FrameError('a 20-byte header has no extension');
  const b = Buffer.alloc(size);
  MAGIC.copy(b, 0);
  b.writeUInt32LE(h.cmd, 4);
  b.writeUInt32LE(h.bodyLen, 8);
  b.writeUInt32LE(h.msgId >>> 0, 12);
  b.writeUInt16LE(h.status, 16);
  b.writeUInt16BE(h.cls, 18);
  if (size === 24) b.writeUInt32LE(h.payloadOffset, 20);
  return b;
}

export function decodeHeader(b: Buffer): BcHeader {
  if (b.length < 20 || !b.subarray(0, 4).equals(MAGIC)) throw new FrameError('bad magic');
  const cls = b.readUInt16BE(18);
  const size = headerSize(cls);
  if (!size) throw new FrameError(`unknown class ${cls.toString(16)}`);
  if (b.length < size) throw new FrameError('short header');
  return {
    cmd: b.readUInt32LE(4),
    bodyLen: b.readUInt32LE(8),
    msgId: b.readUInt32LE(12),
    status: b.readUInt16LE(16),
    cls,
    payloadOffset: size === 24 ? b.readUInt32LE(20) : 0,
    size,
  };
}

export function encodeFrame(f: { cmd: number; msgId: number; status: number; cls: number; ext?: Buffer; body?: Buffer }): Buffer {
  const ext = f.ext ?? Buffer.alloc(0);
  const body = f.body ?? Buffer.alloc(0);
  const header = encodeHeader({ cmd: f.cmd, bodyLen: ext.length + body.length, msgId: f.msgId, status: f.status, cls: f.cls, payloadOffset: ext.length });
  return Buffer.concat([header, ext, body]);
}

// Messages split across reads, and several in one read. Bad magic, an
// unknown class, an oversized length or an extension past the body throws
// FrameError: the caller closes the connection (there is no resync).
export class FrameParser {
  private buf = Buffer.alloc(0);

  constructor(private readonly maxBody = MAX_BODY) {}

  push(chunk: Buffer): BcFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: BcFrame[] = [];
    for (;;) {
      if (this.buf.length >= 4 && !this.buf.subarray(0, 4).equals(MAGIC)) throw new FrameError('bad magic');
      if (this.buf.length < 20) break;
      const size = headerSize(this.buf.readUInt16BE(18));
      if (!size) throw new FrameError('unknown class');
      if (this.buf.length < size) break;
      const header = decodeHeader(this.buf);
      if (header.bodyLen > this.maxBody) throw new FrameError('body too long');
      if (header.payloadOffset > header.bodyLen) throw new FrameError('extension longer than the body');
      const total = size + header.bodyLen;
      if (this.buf.length < total) break;
      out.push({
        header,
        ext: Buffer.from(this.buf.subarray(size, size + header.payloadOffset)),
        body: Buffer.from(this.buf.subarray(size + header.payloadOffset, total)),
      });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/baichuan/frame.test.ts && npm run lint:types`
Expected: PASS (7 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/baichuan/frame.ts test/baichuan/frame.test.ts
git commit -m "feat(baichuan): frame codec and streaming parser"
```

---

### Task 2: Ciphers, pinned to reolink_aio

**Files:**
- Create: `src/baichuan/cipher.ts`, `THIRD_PARTY_NOTICES`
- Modify: `package.json` (`files`)
- Test: `test/baichuan/cipher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `src/baichuan/cipher.ts`):
  - `XML_KEY: Buffer`, `AES_IV: Buffer`
  - `md5_31(s: string): string`
  - `bcXor(data: Buffer, offset: number): Buffer`
  - `aesKey(nonce: string, password: string): Buffer`
  - `aesEncrypt(key: Buffer, data: Buffer): Buffer`, `aesDecrypt(key: Buffer, data: Buffer): Buffer`
  - `encryptChunk(key: Buffer, payload: Buffer, encryptLen: number): Buffer`, `decryptChunk(key, payload, encryptLen): Buffer`

The expected values below came from reolink_aio 0.21.7 as the oracle, with test values only (never the camera's credentials). They are the same vectors cam-proxy's client pins. To reproduce them:

```python
# python -m venv v && v/bin/pip install reolink_aio==0.21.7 pycryptodomex; v/bin/python this.py
from reolink_aio.baichuan.util import encrypt_baichuan, md5_str_modern, AES_IV
from Cryptodome.Cipher import AES
nonce, user, pw = "TESTNONCE0123456789", "proxy", "test-password"
key = md5_str_modern(f"{nonce}-{pw}")[0:16]
aes = lambda d: AES.new(key=key.encode(), mode=AES.MODE_CFB, iv=AES_IV, segment_size=128).encrypt(d)
x = '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n'
print(md5_str_modern("admin"), md5_str_modern(user + nonce), md5_str_modern(pw + nonce), key)
print(encrypt_baichuan(x, 250).hex(), encrypt_baichuan("hello", 0).hex(), aes(x.encode()).hex())
plain = bytes((i * 7 + 3) % 256 for i in range(1100)); enc = aes(plain[:1024]) + plain[1024:]
import hashlib; print(enc[:16].hex(), enc[1020:1030].hex(), hashlib.sha256(enc).hexdigest())
```

- [ ] **Step 1: Write the failing test**

`test/baichuan/cipher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { AES_IV, XML_KEY, aesDecrypt, aesEncrypt, aesKey, bcXor, decryptChunk, encryptChunk, md5_31 } from '../../src/baichuan/cipher';

// Oracle: reolink_aio 0.21.7 (util.py encrypt_baichuan, md5_str_modern;
// AES-CFB128 with AES_IV). Test values only.
const NONCE = 'TESTNONCE0123456789';
const PASSWORD = 'test-password';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n';

describe('Baichuan ciphers (reolink_aio oracle)', () => {
  it('has aio’s constants', () => {
    expect(XML_KEY).toEqual(Buffer.from([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]));
    expect(AES_IV.toString('ascii')).toBe('0123456789abcdef');
  });

  it('md5_31: uppercase hex MD5, 31 characters', () => {
    expect(md5_31('admin')).toBe('21232F297A57A5A743894A0E4A801FC');
    expect(md5_31(`proxy${NONCE}`)).toBe('549605C6E2776B73D2871DD76070126');
    expect(md5_31(`${PASSWORD}${NONCE}`)).toBe('50605965E1AE2C85381D7F6F0A5D501');
  });

  it('derives the session key from the nonce and the password', () => {
    expect(aesKey(NONCE, PASSWORD).toString('ascii')).toBe('15464B50166A7E4E');
  });

  it('XORs with the key and the channel byte as offset; symmetric', () => {
    const enc = bcXor(Buffer.from(XML_HEAD), 250);
    expect(enc.toString('hex')).toBe('fa8ed8feee2593b2b4c2c9fcec38c7e6e88182b3e76b86b8a2d8cef4bf27b083809c98b1a23adbddfad3cff7fb3bef');
    expect(bcXor(Buffer.from('hello'), 0).toString('hex')).toBe('7748502735');
    expect(bcXor(enc, 250).toString()).toBe(XML_HEAD);
  });

  it('AES-128-CFB, the IV restarted for every part', () => {
    const key = aesKey(NONCE, PASSWORD);
    const enc = aesEncrypt(key, Buffer.from(XML_HEAD));
    expect(enc.toString('hex')).toBe('c3151717ce134df0e06c82fc00abe8c16f62465f81fdeffab7d6c70c26e40a893220ff8b2060945f54239158321946');
    expect(aesEncrypt(key, Buffer.from(XML_HEAD))).toEqual(enc);
    expect(aesDecrypt(key, enc).toString()).toBe(XML_HEAD);
  });

  it('chunks: only the first encryptLen bytes are AES', () => {
    const key = aesKey(NONCE, PASSWORD);
    const plain = Buffer.from(Array.from({ length: 1100 }, (_, i) => (i * 7 + 3) % 256));
    const enc = encryptChunk(key, plain, 1024);
    expect(enc.subarray(0, 16).toString('hex')).toBe('fc207e62bd1516a1a95da2c339c8af9c');
    expect(enc.subarray(1020, 1030).toString('hex')).toBe('254ff709030a11181f26');
    expect(createHash('sha256').update(enc).digest('hex')).toBe('cc030d5270e2444eb35c65e87b5b10926ad8e6fa9ce9677736a4f5b812640fa8');
    expect(enc.subarray(1024)).toEqual(plain.subarray(1024));
    expect(decryptChunk(key, enc, 1024)).toEqual(plain);
    // A chunk shorter than encryptLen is AES throughout.
    expect(encryptChunk(key, plain.subarray(0, 100), 1024)).toEqual(aesEncrypt(key, plain.subarray(0, 100)));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/baichuan/cipher.test.ts`
Expected: FAIL, module `../../src/baichuan/cipher` not found.

- [ ] **Step 3: Implement**

`src/baichuan/cipher.ts`:

```ts
// Baichuan ciphers. Written for cam-sim after reolink_aio 5d37cb3
// (baichuan/util.py L17-L118, baichuan.py L432-L532), MIT (see
// THIRD_PARTY_NOTICES). Pinned to aio vectors in test/baichuan/cipher.test.ts.
import { createCipheriv, createDecipheriv, createHash } from 'crypto';

// aio util.py L17-L22.
export const XML_KEY = Buffer.from([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]);
export const AES_IV = Buffer.from('0123456789abcdef', 'ascii');

// Uppercase hex MD5, truncated to 31 characters (aio md5_str_modern).
export function md5_31(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex').toUpperCase().slice(0, 31);
}

// The "BC" XOR of the nonce reply, the login and the login reply; symmetric.
// `offset` is the header's channel byte.
export function bcXor(data: Buffer, offset: number): Buffer {
  const o = offset & 0xff;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ XML_KEY[(o + i) % 8] ^ o;
  return out;
}

// The session key: the first 16 characters of md5_31(nonce-password), as ASCII.
export function aesKey(nonce: string, password: string): Buffer {
  return Buffer.from(md5_31(`${nonce}-${password}`).slice(0, 16), 'ascii');
}

// AES-128-CFB with 128-bit segments; every part starts from the fixed IV.
export function aesEncrypt(key: Buffer, data: Buffer): Buffer {
  const c = createCipheriv('aes-128-cfb', key, AES_IV);
  return Buffer.concat([c.update(data), c.final()]);
}

export function aesDecrypt(key: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv('aes-128-cfb', key, AES_IV);
  return Buffer.concat([d.update(data), d.final()]);
}

// Download chunks: only the first `encryptLen` bytes are AES, the rest plain.
export function encryptChunk(key: Buffer, payload: Buffer, encryptLen: number): Buffer {
  const n = Math.min(encryptLen, payload.length);
  return Buffer.concat([aesEncrypt(key, payload.subarray(0, n)), payload.subarray(n)]);
}

export function decryptChunk(key: Buffer, payload: Buffer, encryptLen: number): Buffer {
  const n = Math.min(encryptLen, payload.length);
  return Buffer.concat([aesDecrypt(key, payload.subarray(0, n)), payload.subarray(n)]);
}
```

`THIRD_PARTY_NOTICES`:

```text
cam-sim's Baichuan code (src/baichuan/) was written for cam-sim after the
sources below. Nothing was taken from Neolink (AGPL-3.0).

reolink_aio
  https://github.com/starkillerOG/reolink_aio
  commit 5d37cb3df2a49bb8eeafa93fa02513df88ad527a
and its pull request #186, "Add VOD file download over Baichuan"
  https://github.com/1eft0ver/reolink_aio
  commit 9a1bb5238b43ecc9d8fbe05c7e5679a7ad8a06f2

MIT License

Copyright (c) 2023 starkillerOG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`package.json`: in `"files"`, add `"THIRD_PARTY_NOTICES"` after `"openapi.yaml"`.

- [ ] **Step 4: Run the tests, and check the notice against the pinned commit**

```bash
npx vitest run test/baichuan/cipher.test.ts && npm run lint:types
curl -fsSL https://raw.githubusercontent.com/starkillerOG/reolink_aio/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/LICENSE \
  | diff <(sed -n '/^MIT License/,$p' THIRD_PARTY_NOTICES) - && echo notice-ok
npm pack --dry-run 2>&1 | grep -q THIRD_PARTY_NOTICES && echo packed-ok
```

Expected:
- The tests PASS (6 tests).
- `notice-ok`; if `diff` shows a difference, copy the license text at that commit into the notice.
- `packed-ok`.

- [ ] **Step 5: Commit**

```bash
git add src/baichuan/cipher.ts test/baichuan/cipher.test.ts THIRD_PARTY_NOTICES package.json
git commit -m "feat(baichuan): XOR, AES-128-CFB and chunk ciphers, pinned to reolink_aio"
```

---

### Task 3: Messages from the traces

**Files:**
- Create: `src/baichuan/device-info.ts` (generated), `src/baichuan/xml.ts`, `src/baichuan/records.ts`, `test/baichuan/trace.ts`
- Test: `test/baichuan/traces.test.ts`

**Interfaces:**
- Consumes: `decodeHeader`, `encodeHeader` (Task 1).
- Produces:
  - From `src/baichuan/device-info.ts`: `LOGIN_REPLY_LINES: readonly string[]` (192 lines).
  - From `src/baichuan/xml.ts`:
    - `doc(lines: readonly string[]): string`, `bodyXml(inner: readonly string[]): string`
    - `nonceXml(nonce: string): string`
    - `loginReplyXml(secretCode: string, bootSecret: string): string`
    - `LOGIN_ERR_XML`, `LINK_TYPE_XML`, `EXT_BINARY`, `EXT_CHUNK: string`; `ENCRYPT_LEN = 1024`
    - `interface PushMessage { cmd: number; afterMs: number; xml: string }`; `PUSHES: readonly PushMessage[]`
    - `interface Moment { year; month; day; hour; minute; second: number }`
    - `fileInfoXml(f: { name: string; size: number; start: Moment; end: Moment }): string`
    - `tagValue(xml: string, tag: string): string | undefined`
  - From `src/baichuan/records.ts`:
    - `infoRecord(r: { width: number; height: number; fps: number; start: Moment; end: Moment; main: boolean }): Buffer`
    - `CHUNK_CYCLE`, `chunkSize(index: number, remaining: number): number`, `chunkSizes(total: number): number[]`
  - From `test/baichuan/trace.ts`:
    - `TRACE_DIR: string`
    - `interface TraceMessage { dir: 'in' | 'out'; cmd: number; label: string; header: Buffer; xml: string }`
    - `readTrace(file: string): TraceMessage[]`

- [ ] **Step 1: Generate `src/baichuan/device-info.ts` from the trace**

The login reply is about 5 KB of XML, so it is generated rather than typed:

```bash
node -e '
const fs = require("fs");
const lines = fs.readFileSync("reference/rlc-1224a/baichuan/login-admin.txt", "utf8").split("\n");
const at = lines.findIndex((l) => l.includes("status=200 len=5136"));
const xml = [];
for (const l of lines.slice(at + 1)) { if (!l.startsWith("    ")) break; xml.push(l.slice(4)); }
const head = [
  "// The RLC-1224A login reply (DeviceInfo and StreamInfoList), firmware v3.2.0.6011,",
  "// line by line from reference/rlc-1224a/baichuan/login-admin.txt. secretCode and",
  "// bootSecret were redacted in the trace; the server fills them in. Generated by",
  "// the command in docs/superpowers/plans/2026-10-02-baichuan-server.md, Task 3.",
];
fs.writeFileSync("src/baichuan/device-info.ts", head.join("\n") + "\nexport const LOGIN_REPLY_LINES: readonly string[] = [\n" + xml.map((l) => "  " + JSON.stringify(l) + ",").join("\n") + "\n];\n");
console.log(xml.length);
'
```

Expected output: `192`. Check: `head -6 src/baichuan/device-info.ts` shows the comment, then `export const LOGIN_REPLY_LINES…`, then `"<?xml version=\"1.0\" encoding=\"UTF-8\" ?>",`.

- [ ] **Step 2: Write the trace reader and the failing test**

`test/baichuan/trace.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';

// Reads reference/rlc-1224a/baichuan/*.txt: one message per line
// ("-> cmd 8 (download) hdr[24]=[f0 de …]"), then its decrypted XML indented
// by four spaces. Lines in parentheses are placeholders and are skipped.
export const TRACE_DIR = join(__dirname, '..', '..', 'reference', 'rlc-1224a', 'baichuan');

export interface TraceMessage {
  dir: 'in' | 'out'; // in: sent by the client (->); out: sent by the camera (<-)
  cmd: number;
  label: string;
  header: Buffer;
  xml: string; // the lines as the camera sent them, each ending in "\n"; '' when none
}

const LINE = /^\s+[\d.]+\s+(->|<-) cmd (\d+)(?: \(([^)]*)\))? hdr\[(\d+)\]=\[([0-9a-f ]+)\]/;

export function readTrace(file: string): TraceMessage[] {
  const out: TraceMessage[] = [];
  let cur: TraceMessage | undefined;
  let xml: string[] = [];
  const flush = () => {
    if (cur) out.push({ ...cur, xml: xml.map((l) => `${l}\n`).join('') });
    cur = undefined;
    xml = [];
  };
  for (const raw of readFileSync(join(TRACE_DIR, file), 'utf8').split('\n')) {
    const m = LINE.exec(raw);
    if (m) {
      flush();
      cur = { dir: m[1] === '<-' ? 'out' : 'in', cmd: Number(m[2]), label: m[3] ?? '', header: Buffer.from(m[5].replace(/ /g, ''), 'hex'), xml: '' };
    } else if (raw.startsWith('    (')) {
      continue;
    } else if (cur && raw.startsWith('    ')) {
      xml.push(raw.slice(4));
    } else {
      flush();
    }
  }
  flush();
  return out;
}
```

`test/baichuan/traces.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/baichuan/traces.test.ts`
Expected: FAIL. `../../src/baichuan/xml` and `../../src/baichuan/records` cannot be resolved.

- [ ] **Step 4: Implement**

`src/baichuan/xml.ts`:

```ts
// Message bodies as the RLC-1224A sends them: one tag per line, each line
// ending in "\n", so lengths equal the traces (reference/rlc-1224a/baichuan/).
// Templates after reolink_aio 5d37cb3 and PR #186 9a1bb52 (MIT, THIRD_PARTY_NOTICES).
import { LOGIN_REPLY_LINES } from './device-info';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" ?>';
export const doc = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');
export const bodyXml = (inner: readonly string[]): string => doc([XML_DECL, '<body>', ...inner, '</body>']);
const extXml = (inner: readonly string[]): string => doc([XML_DECL, '<Extension version="1.1">', ...inner, '</Extension>']);

export function nonceXml(nonce: string): string {
  return bodyXml([
    '<Encryption version="1.1">', '<type>md5</type>', `<nonce>${nonce}</nonce>`, '<authTypeList>',
    '<authType>password</authType>', '<authType>sigV1</authType>', '<authType>authLogin</authType>', '<authType>getAccesskey</authType>',
    '</authTypeList>', '</Encryption>',
  ]);
}

// Measured: wrong credentials answer 401 with this body (the sim never locks).
export const LOGIN_ERR_XML = bodyXml(['<LoginErrInfo version="1.1">', '<remainTimes>10</remainTimes>', '</LoginErrInfo>']);
export const LINK_TYPE_XML = bodyXml(['<LinkType version="1.1">', '<type>LAN</type>', '</LinkType>']);

export const ENCRYPT_LEN = 1024;
export const EXT_BINARY = extXml(['<binaryData>1</binaryData>']);
export const EXT_CHUNK = extXml(['<binaryData>1</binaryData>', `<encryptLen>${ENCRYPT_LEN}</encryptLen>`]);

const SECRET_CODE = '<secretCode>REDACTED</secretCode>';
const BOOT_SECRET = '<bootSecret>REDACTED</bootSecret>';
export function loginReplyXml(secretCode: string, bootSecret: string): string {
  return doc(LOGIN_REPLY_LINES.map((l) => (l === SECRET_CODE ? `<secretCode>${secretCode}</secretCode>` : l === BOOT_SECRET ? `<bootSecret>${bootSecret}</bootSecret>` : l)));
}

// Measured (idle.txt): unsolicited after a login, message id 0, channel 0.
export interface PushMessage {
  cmd: number;
  afterMs: number; // after the login reply
  xml: string;
}
export const PUSHES: readonly PushMessage[] = [
  { cmd: 78, afterMs: 40, xml: bodyXml(['<VideoInput version="1.1">', '<channelId>0</channelId>', '<bright>128</bright>', '<contrast>128</contrast>', '<saturation>128</saturation>', '<hue>128</hue>', '</VideoInput>']) },
  { cmd: 79, afterMs: 40, xml: bodyXml(['<Serial version="1.1">', '<channelId>0</channelId>', '<baudRate>9600</baudRate>', '<dataBit>CS8</dataBit>', '<stopBit>1</stopBit>', '<parity>none</parity>', '<flowControl>none</flowControl>', '<controlProtocol>PELCO_D</controlProtocol>', '<controlAddress>1</controlAddress>', '</Serial>']) },
  { cmd: 464, afterMs: 300, xml: bodyXml(['<NetInfo version="1.1">', '<net_type>wire</net_type>', '<signal>100</signal>', '</NetInfo>']) },
  { cmd: 547, afterMs: 300, xml: bodyXml(['<SirenStatusList version="1.1" />']) },
  { cmd: 291, afterMs: 500, xml: bodyXml(['<FloodlightStatusList version="1.1">', '<FloodlightStatus>', '<channel>0</channel>', '<status>0</status>', '<brightness>100</brightness>', '</FloodlightStatus>', '</FloodlightStatusList>']) },
  { cmd: 677, afterMs: 500, xml: bodyXml(['<ioStatus version="1.1">', '<statusList>', '<channel>0</channel>', '</statusList>', '</ioStatus>']) },
  { cmd: 600, afterMs: 500, xml: bodyXml(['<yoloWorldEventList version="1.1" />']) },
  { cmd: 669, afterMs: 500, xml: bodyXml(['<AiModelList version="1.1">', '<AiModelItem>', '<name>clip</name>', '<version>1</version>', '</AiModelItem>', '</AiModelList>']) },
];

// Camera-local date and time, as the FileInfo XML and the info record carry it.
export interface Moment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const momentXml = (tag: string, m: Moment) => [
  `<${tag}>`, `<year>${m.year}</year>`, `<month>${m.month}</month>`, `<day>${m.day}</day>`,
  `<hour>${m.hour}</hour>`, `<minute>${m.minute}</minute>`, `<second>${m.second}</second>`, `</${tag}>`,
];

// cmd 13's reply (fileinfo.txt). handle is always 0 on the camera.
export function fileInfoXml(f: { name: string; size: number; start: Moment; end: Moment }): string {
  return bodyXml([
    '<FileInfoList version="1.1">', '<FileInfo>', '<channelId>0</channelId>', '<handle>0</handle>', `<name>${f.name}</name>`,
    '<containsAudio>1</containsAudio>', '<fileType>h264</fileType>', '<recordType>none</recordType>', '<supportSub>1</supportSub>',
    `<sizeL>${f.size % 2 ** 32}</sizeL>`, `<sizeH>${Math.floor(f.size / 2 ** 32)}</sizeH>`,
    ...momentXml('startTime', f.start), ...momentXml('endTime', f.end),
    '</FileInfo>', '</FileInfoList>',
  ]);
}

// The text of the first <tag>…</tag>; undefined when there is none.
export function tagValue(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const i = xml.indexOf(open);
  if (i < 0) return undefined;
  const j = xml.indexOf(`</${tag}>`, i + open.length);
  return j < 0 ? undefined : xml.slice(i + open.length, j);
}
```

`src/baichuan/records.ts`:

```ts
// The binary parts of a cmd-8 download, as measured on the RLC-1224A
// (reference/rlc-1224a/baichuan/README.md, "Download").
import type { Moment } from './xml';

// The 32-byte record before the file data in cmd 8's first reply: "1002",
// u32 32, u32 width, u32 height, 0, fps, start and end (y-1900, month, day,
// hour, minute, second), a main/sub flag (1 = main), 0. Not file content.
export function infoRecord(r: { width: number; height: number; fps: number; start: Moment; end: Moment; main: boolean }): Buffer {
  const b = Buffer.alloc(32);
  b.write('1002', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.writeUInt32LE(r.width, 8);
  b.writeUInt32LE(r.height, 12);
  b[16] = 0;
  b[17] = r.fps;
  const put = (at: number, m: Moment) => {
    b[at] = m.year - 1900;
    b[at + 1] = m.month;
    b[at + 2] = m.day;
    b[at + 3] = m.hour;
    b[at + 4] = m.minute;
    b[at + 5] = m.second;
  };
  put(18, r.start);
  put(24, r.end);
  b[30] = r.main ? 1 : 0;
  b[31] = 0;
  return b;
}

// Chunk payloads: 39,400 three times, then 12,872 (one 128 KiB block),
// repeating; the last one is whatever is left.
export const CHUNK_CYCLE = [39_400, 39_400, 39_400, 12_872] as const;

export function chunkSize(index: number, remaining: number): number {
  return Math.min(CHUNK_CYCLE[index % CHUNK_CYCLE.length], remaining);
}

export function chunkSizes(total: number): number[] {
  const out: number[] = [];
  for (let i = 0, left = total; left > 0; i++) {
    const n = chunkSize(i, left);
    out.push(n);
    left -= n;
  }
  return out;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/baichuan/traces.test.ts && npm run lint:types`
Expected: PASS (10 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/baichuan/device-info.ts src/baichuan/xml.ts src/baichuan/records.ts test/baichuan/trace.ts test/baichuan/traces.test.ts
git commit -m "feat(baichuan): reply bodies, info record and chunk sizes from the traces"
```

---

### Task 4: Engine plumbing (config, faults, counters, sessions, hooks)

**Files:**
- Modify: `src/config.ts`, `src/engine/faults.ts`, `src/engine/counters.ts`, `src/engine/sessions.ts`, `src/engine/engine.ts`, `src/index.ts` (only `CamSimOptions` and `configFromOptions`)
- Test: `test/config.test.ts`, `test/faults.test.ts`, `test/sessions.test.ts`, `test/index.test.ts`, `test/baichuan/engine-hooks.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - From `src/config.ts`:
    - `BAICHUAN_IDLE_MS = 32_000`, `BAICHUAN_FIRST_MESSAGE_MS = 12_500`, `BAICHUAN_SESSION_LIMIT = 12`
    - `CamSimConfig.ports.baichuan: number`
    - `CamSimConfig.baichuan: { idleMs: number; firstMessageMs: number }`
  - From `src/engine/faults.ts`:
    - `FaultName` gains `'baichuan.refuse' | 'baichuan.dropMidway' | 'baichuan.delayMs' | 'baichuan.loginFail' | 'baichuan.sessionLimit'`
    - `FaultSpec.max?: number`
  - From `src/engine/counters.ts`: `Counters.baichuanSessions`, `baichuanLogins`, `baichuanDownloads`, `droppedBaichuanDownloads` (numbers).
  - From `src/engine/sessions.ts`:
    - `Sessions.openBaichuan(user: User, ip: string): number`
    - `Sessions.closeBaichuan(sessionId: number): void`
    - `Sessions.findUser(match: (u: User) => boolean): User | undefined`
  - From `src/engine/engine.ts`:
    - `RequestRecord.port: 'http' | 'https' | 'baichuan'`, `RequestRecord.len?: number`, `RequestRecord.replyLen?: number`
    - `Engine.baichuan?: { dropAll(): void; dropTransfers(): void }`
  - From `src/index.ts`: `CamSimOptions.baichuan?: { idleMs?: number; firstMessageMs?: number }`; `configFromOptions` sets `ports.baichuan = 0`.

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`: add `BAICHUAN_FIRST_MESSAGE_MS, BAICHUAN_IDLE_MS, BAICHUAN_SESSION_LIMIT` to the import from `../src/config`, and append inside `describe('loadConfig', …)`:

```ts
  it('reads CAMSIM_BAICHUAN_PORT (default 9000) and has the measured Baichuan limits', () => {
    expect(loadConfig(base).ports.baichuan).toBe(9000);
    expect(loadConfig({ ...base, CAMSIM_BAICHUAN_PORT: '0' }).ports.baichuan).toBe(0);
    expect(() => loadConfig({ ...base, CAMSIM_BAICHUAN_PORT: '70000' })).toThrow(/CAMSIM_BAICHUAN_PORT/);
    expect(loadConfig(base).baichuan).toEqual({ idleMs: 32_000, firstMessageMs: 12_500 });
    expect([BAICHUAN_IDLE_MS, BAICHUAN_FIRST_MESSAGE_MS, BAICHUAN_SESSION_LIMIT]).toEqual([32_000, 12_500, 12]);
  });
```

`test/faults.test.ts`: append inside `describe('Faults', …)`:

```ts
  it('knows the Baichuan faults: sessionLimit needs a positive max, delayMs needs ms', () => {
    const f = new Faults();
    for (const n of ['baichuan.refuse', 'baichuan.dropMidway', 'baichuan.delayMs', 'baichuan.loginFail', 'baichuan.sessionLimit']) expect(FAULT_NAMES).toContain(n);
    expect(() => f.set({ name: 'baichuan.sessionLimit' })).toThrow(/max/);
    expect(() => f.set({ name: 'baichuan.sessionLimit', max: 0 })).toThrow(/max/);
    expect(() => f.set({ name: 'baichuan.sessionLimit', max: 1.5 })).toThrow(/max/);
    expect(() => f.set({ name: 'baichuan.delayMs' })).toThrow(/ms/);
    f.set({ name: 'baichuan.sessionLimit', max: 3 });
    expect(f.active('baichuan.sessionLimit')).toEqual({ name: 'baichuan.sessionLimit', max: 3 });
    f.set({ name: 'baichuan.refuse', max: 3 }); // max belongs to sessionLimit only
    expect(f.active('baichuan.refuse')).toEqual({ name: 'baichuan.refuse' });
    f.set({ name: 'baichuan.loginFail', count: 2 });
    f.consume('baichuan.loginFail');
    f.consume('baichuan.loginFail');
    expect(f.active('baichuan.loginFail')).toBeUndefined();
  });

  it('resets the Baichuan history but not the open Baichuan sessions', () => {
    const c = new Counters();
    Object.assign(c, { baichuanSessions: 2, baichuanLogins: 3, baichuanDownloads: 4, droppedBaichuanDownloads: 1 });
    c.reset();
    expect(c.snapshot()).toMatchObject({ baichuanSessions: 2, baichuanLogins: 0, baichuanDownloads: 0, droppedBaichuanDownloads: 0 });
  });
```

`test/sessions.test.ts`: append inside `describe('Sessions', …)`:

```ts
  it('lists Baichuan sessions in online() with the shared ids, not in count(); a revoke leaves them', () => {
    const { s } = make();
    s.login('admin', 'a', '10.0.0.1');
    const id = s.openBaichuan({ name: 'cams', level: 'admin', password: 'c' }, '10.0.0.2');
    expect(id).toBe(11);
    expect(s.online()).toEqual([
      { canbeDisconn: 0, ip: '10.0.0.1', level: 'admin', sessionId: 10, userName: 'admin' },
      { canbeDisconn: 0, ip: '10.0.0.2', level: 'admin', sessionId: 11, userName: 'cams' },
    ]);
    expect(s.count()).toBe(1);
    s.revokeAll();
    expect(s.online().map((o) => o.sessionId)).toEqual([11]);
    s.closeBaichuan(id);
    expect(s.online()).toEqual([]);
  });

  it('findUser answers a copy of the current user', () => {
    const { s } = make();
    expect(s.modifyUser('cams', { password: 'new' })).toBeNull();
    const u = s.findUser((x) => x.name === 'cams')!;
    expect(u.password).toBe('new');
    u.password = 'changed';
    expect(s.findUser((x) => x.name === 'cams')!.password).toBe('new');
    expect(s.findUser(() => false)).toBeUndefined();
  });
```

`test/index.test.ts`: change the import to `import { createCamSim, configFromOptions, DEMO_CLIPS, type CamSim } from '../src/index';` and append inside `describe('createCamSim', …)`:

```ts
  it('in process: a free Baichuan port by default, and shorter idle times on request', () => {
    const c = configFromOptions({ users: [] });
    expect(c.ports.baichuan).toBe(0);
    expect(c.baichuan).toEqual({ idleMs: 32_000, firstMessageMs: 12_500 });
    expect(configFromOptions({ users: [], baichuan: { idleMs: 500 } }).baichuan).toEqual({ idleMs: 500, firstMessageMs: 12_500 });
  });
```

`test/baichuan/engine-hooks.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeEngine, login, post } from '../helpers';
import { createCameraApp } from '../../src/camera-api/app';

describe('engine hooks for port 9000', () => {
  it('downloads.dropActive, power-off and reboot reach the Baichuan server', async () => {
    const e = await makeEngine();
    const hooks = { dropAll: vi.fn(), dropTransfers: vi.fn() };
    e.baichuan = hooks;
    e.dropDownloads();
    expect(hooks.dropTransfers).toHaveBeenCalledTimes(1);
    expect(e.powerOff()).toBe(true);
    expect(hooks.dropAll).toHaveBeenCalledTimes(1);
    await e.powerOn(0);
    await e.reboot({ ms: 0 });
    expect(hooks.dropAll).toHaveBeenCalledTimes(2);
  });

  it('HTTP GetOnline lists a Baichuan session after the HTTP ones', async () => {
    const e = await makeEngine();
    const cam = createCameraApp(e, { port: 'http' });
    const t = await login(cam);
    e.sessions.openBaichuan({ name: 'admin', level: 'admin', password: 'admin-pw' }, '10.0.0.9');
    const users = (await post(cam, 'GetOnline', {}, t)).reply.value.User;
    expect(users.map((u: { userName: string }) => u.userName)).toEqual(['cams', 'admin']);
    expect(users[1]).toMatchObject({ ip: '10.0.0.9', level: 'admin', canbeDisconn: 0 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/config.test.ts test/faults.test.ts test/sessions.test.ts test/index.test.ts test/baichuan/engine-hooks.test.ts`
Expected: FAIL. `ports.baichuan` is undefined, there is no fault `baichuan.sessionLimit`, `openBaichuan is not a function`, `c.ports.baichuan` is undefined, and `hooks.dropTransfers` has 0 calls.

- [ ] **Step 3: Implement**

`src/config.ts`:
- After the `ConfigError` class, add:

```ts
// Baichuan (TCP 9000), measured on the RLC-1224A (reference/rlc-1224a/baichuan/):
// a logged-in connection closes about 32 s after the client's last message, one
// that never sends after 12.5 s; 12 connections at once, bare ones included.
export const BAICHUAN_IDLE_MS = 32_000;
export const BAICHUAN_FIRST_MESSAGE_MS = 12_500;
export const BAICHUAN_SESSION_LIMIT = 12;
```

- In `CamSimConfig`, change `ports` and add `baichuan` after it:

```ts
  ports: { https: number; http: number; control: number; rtsp: number; onvif: number; baichuan: number };
  // Baichuan idle timeouts (ms); tests shorten them.
  baichuan: { idleMs: number; firstMessageMs: number };
```

- In the returned object of `loadConfig`, change `ports` and add `baichuan` after it:

```ts
    ports: {
      https: port('CAMSIM_HTTPS_PORT', 8443),
      http: port('CAMSIM_HTTP_PORT', 8080),
      control: port('CAMSIM_CONTROL_PORT', 9443),
      rtsp: port('CAMSIM_RTSP_PORT', 8554),
      onvif: port('CAMSIM_ONVIF_PORT', 8000),
      baichuan: port('CAMSIM_BAICHUAN_PORT', 9000),
    },
    baichuan: { idleMs: BAICHUAN_IDLE_MS, firstMessageMs: BAICHUAN_FIRST_MESSAGE_MS },
```

`src/engine/faults.ts`:
- Replace `FAULT_NAMES` with:

```ts
export const FAULT_NAMES = [
  'downloads.refuse', 'downloads.dropFirst', 'downloads.dropMidway', 'downloads.delayMs',
  'flv.reset', 'flv.delayMs', 'search.delayMs',
  'settings.fail', 'settings.ignore', 'settings.strictPartial',
  'offline', 'latencyMs', 'snap.fail',
  'ftp.fail', 'ftp.delayMs',
  'rtsp.refuse', 'rtsp.reset',
  'baichuan.refuse', 'baichuan.dropMidway', 'baichuan.delayMs', 'baichuan.loginFail', 'baichuan.sessionLimit',
] as const;
```

- In `FaultSpec`, add after `rspCode?: number;`:

```ts
  max?: number; // baichuan.sessionLimit only: Baichuan connections at once
```

- Replace `NEEDS_MS` with:

```ts
const NEEDS_MS: FaultName[] = ['downloads.delayMs', 'flv.delayMs', 'search.delayMs', 'latencyMs', 'ftp.delayMs', 'baichuan.delayMs'];
```

- In `set()`, after the `NEEDS_CMDS` check, add:

```ts
    if (name === 'baichuan.sessionLimit' && !(Number.isInteger(spec.max) && (spec.max as number) > 0)) {
      throw new FaultError('baichuan.sessionLimit needs max (a positive integer)');
    }
```

  and after the `rspCode` line, add:

```ts
    if (name === 'baichuan.sessionLimit') clean.max = spec.max;
```

`src/engine/counters.ts`:
- Add after `ftpDropped = 0;`:

```ts
  baichuanSessions = 0; // logged-in Baichuan connections now (not history)
  baichuanLogins = 0;
  baichuanDownloads = 0;
  droppedBaichuanDownloads = 0;
```

- In `reset()`, add `baichuanLogins: 0, baichuanDownloads: 0, droppedBaichuanDownloads: 0` to the `Object.assign` object. `baichuanSessions` stays, like `activeDownloads`.

`src/engine/sessions.ts`:
- Add a field after `nextId`:

```ts
  private readonly baichuan = new Map<number, { user: User; ip: string }>();
```

- Replace `count()` and `online()` with:

```ts
  // HTTP sessions only (the state's activeSessions).
  count(): number {
    return this.httpOnline().length;
  }

  // GetOnline: HTTP and Baichuan sessions, by session id, as on the camera.
  online() {
    const bc = [...this.baichuan].map(([sessionId, s]) => ({ canbeDisconn: 0, ip: s.ip, level: s.user.level, sessionId, userName: s.user.name }));
    return [...this.httpOnline(), ...bc].sort((a, b) => a.sessionId - b.sessionId);
  }

  private httpOnline() {
    const now = this.clock.now().getTime();
    const out = [];
    for (const [t, s] of this.tokens) {
      if (s.expiresAt <= now) {
        this.tokens.delete(t);
        continue;
      }
      out.push({ canbeDisconn: 0, ip: s.ip, level: s.user.level, sessionId: s.sessionId, userName: s.user.name });
    }
    return out;
  }

  // Baichuan (port 9000) sessions: one per logged-in TCP connection. They take
  // session ids from the same counter and show in GetOnline, but they are not
  // tokens: the connection ends them, not a lease, a logout or a revoke.
  openBaichuan(user: User, ip: string): number {
    const sessionId = this.nextId++;
    this.baichuan.set(sessionId, { user: { ...user }, ip });
    return sessionId;
  }

  closeBaichuan(sessionId: number): void {
    this.baichuan.delete(sessionId);
  }

  // A copy of the first user that matches (the Baichuan login compares hashes).
  findUser(match: (u: User) => boolean): User | undefined {
    const u = this.userList.find(match);
    return u && { ...u };
  }
```

`src/engine/engine.ts`:
- Replace `RequestRecord` with:

```ts
export interface RequestRecord {
  at: string;
  port: 'http' | 'https' | 'baichuan';
  method: string;
  path: string;
  cmd: string;
  status: number;
  ms: number;
  // Baichuan only: the request's and the direct reply's body lengths, never the bodies.
  len?: number;
  replyLen?: number;
}
```

- In `Engine`, after `liveSub?: LiveSubSource; // set by SdPipeline`, add:

```ts
  // Set by the Baichuan server (src/baichuan/server.ts): device actions reach port 9000.
  baichuan?: { dropAll(): void; dropTransfers(): void };
```

- In `reboot()` and in `powerOff()`, directly after `this.dropDownloads();`, add `this.baichuan?.dropAll();`.
- Replace `dropDownloads()` with:

```ts
  // HTTP downloads in flight, and Baichuan transfers (their connections close).
  dropDownloads(): void {
    for (const res of this.activeDownloads) res.destroy();
    this.baichuan?.dropTransfers();
  }
```

`src/index.ts`:
- Add a value import: `import { BAICHUAN_FIRST_MESSAGE_MS, BAICHUAN_IDLE_MS } from './config';`.
- In `CamSimOptions`, after `log?: pino.Logger;`, add:

```ts
  baichuan?: { idleMs?: number; firstMessageMs?: number }; // shorter Baichuan idle closes, for tests
```

- In `configFromOptions`, replace the `ports` line and add `baichuan` after it:

```ts
    // In process the Baichuan port defaults to a free one: callers that don't
    // name it (cams' and cam-proxy's tests, in parallel) never collide on 9000.
    ports: { https: 8443, http: 8080, control: 9443, rtsp: 8554, onvif: 8000, baichuan: 0 },
    baichuan: { idleMs: o.baichuan?.idleMs ?? BAICHUAN_IDLE_MS, firstMessageMs: o.baichuan?.firstMessageMs ?? BAICHUAN_FIRST_MESSAGE_MS },
```

- [ ] **Step 4: Run them to verify they pass, and the whole suite**

Run: `npx vitest run && npm run lint:types`
Expected: PASS, including the existing control API test with `activeSessions: 1`. No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/engine/faults.ts src/engine/counters.ts src/engine/sessions.ts src/engine/engine.ts src/index.ts \
  test/config.test.ts test/faults.test.ts test/sessions.test.ts test/index.test.ts test/baichuan/engine-hooks.test.ts
git commit -m "feat(baichuan): config, faults, counters, GetOnline sessions and engine hooks"
```

---

### Task 5: The Baichuan server: connections and sessions

**Files:**
- Create: `src/baichuan/server.ts`, `test/baichuan/client.ts`, `test/baichuan/harness.ts`
- Test: `test/baichuan/session.test.ts`, `test/baichuan/connections.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `FrameParser`, `encodeFrame`, `channelOf`, the class and status constants, `BcFrame`.
  - Task 2: `bcXor`, `md5_31`, `aesKey`, `aesEncrypt`.
  - Task 3: `nonceXml`, `loginReplyXml`, `LOGIN_ERR_XML`, `LINK_TYPE_XML`, `PUSHES`, `PushMessage`, `tagValue`; `readTrace`.
  - Task 4: `engine.sessions.findUser/openBaichuan/closeBaichuan`, `engine.counters.baichuan*`, `engine.faults` (`baichuan.loginFail`, `baichuan.sessionLimit`, `offline`), `engine.baichuan`, `engine.recordRequest`, `config.baichuan`, `BAICHUAN_SESSION_LIMIT`.
- Produces:
  - From `src/baichuan/server.ts`:
    - `interface BaichuanOptions { idleMs?: number; firstMessageMs?: number }`
    - `interface TransferLike { readonly done: boolean; cancel(): void; stop(): void }`
    - `class BaichuanServer`:
      - `constructor(engine: Engine, opts?: BaichuanOptions)`
      - `listen(port: number, host?: string): Promise<number>`
      - `close(): Promise<void>`
      - `connectionCount(): number`, `writeBacklog(): number`
      - `dropAll(): void`, `dropTransfers(): void`
    - Task 6 adds the cases for cmds 8, 9 and 13 to the private `handle()` switch, plus the private methods `requestXml()` and `download()`.
  - From `test/baichuan/client.ts`:
    - `class BcClient`:
      - `static connect(port: number): Promise<BcClient>`
      - fields `frames`, `times`, `key`, `nonce`, `closed`, `ended: Promise<'eof' | 'reset'>`, `socket`
      - `nonceRequest()`, `login(user, password)`
      - `send(cmd, xml?): number`, `call(cmd, xml?, ms?)`, `reply(msgId, cmd, ms?)`
      - `waitIndex(pred, ms?, from?)`, `waitFor(pred, ms?)`
      - `text(frame, part?)`, `download(id, size, opts?)`, `collect(msgId, size, ms?)`
      - `write(raw)`, `nextId()`, `close()`
    - Builders `loginXml`, `logoutXml`, `downloadXml`, `fileInfoRequestXml`, `stopXml`, and `msgIdOf`.
  - From `test/baichuan/harness.ts`:
    - `BC_USERS`, `DEMO`
    - `startBc(opts?)` → `{ engine, server, port, connect, loggedIn }`
    - `closeAll()`, `track(fn)`, `until(f, ms?)`, `sleep(ms)`

- [ ] **Step 1: Write the test client and harness**

`test/baichuan/client.ts`:

```ts
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
```

`test/baichuan/harness.ts`:

```ts
import type pino from 'pino';
import { makeEngine } from '../helpers';
import { BaichuanServer } from '../../src/baichuan/server';
import { BcClient } from './client';
import type { Clock } from '../../src/engine/clock';

// admin, a second admin for HTTP (`login()`'s default), proxy (admin level on
// the real camera) and a guest.
export const BC_USERS = 'admin:admin:admin-pw;cams:admin:cams-pw;proxy:admin:proxy-pw;viewer:guest:viewer-pw';
export const DEMO = { CAMSIM_SEED_CLIPS: 'demo' };

const closers: Array<() => Promise<void> | void> = [];
export function track(fn: () => Promise<void> | void): void {
  closers.push(fn);
}
export async function closeAll(): Promise<void> {
  while (closers.length) await closers.pop()!();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(f: () => boolean, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !f(); await sleep(10)) if (Date.now() - t0 > ms) throw new Error('timed out');
}

export async function startBc(opts: { env?: Record<string, string>; idleMs?: number; firstMessageMs?: number; clock?: Clock; log?: pino.Logger } = {}) {
  const deps: { clock?: Clock; log?: pino.Logger } = {};
  if (opts.clock) deps.clock = opts.clock;
  if (opts.log) deps.log = opts.log;
  const engine = await makeEngine({ CAMSIM_USERS: BC_USERS, ...opts.env }, deps);
  const server = new BaichuanServer(engine, { idleMs: opts.idleMs, firstMessageMs: opts.firstMessageMs });
  const port = await server.listen(0, '127.0.0.1');
  const clients: BcClient[] = [];
  const connect = async () => {
    const c = await BcClient.connect(port);
    clients.push(c);
    return c;
  };
  const loggedIn = async (user = 'proxy', password = 'proxy-pw') => {
    const c = await connect();
    const r = await c.login(user, password);
    if (r.header.status !== 200) throw new Error(`login answered ${r.header.status}`);
    return c;
  };
  track(async () => {
    for (const c of clients) c.close();
    await server.close();
  });
  return { engine, server, port, connect, loggedIn };
}
```

- [ ] **Step 2: Write the failing tests**

`test/baichuan/session.test.ts`:

```ts
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
```

`test/baichuan/connections.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { startBc, closeAll, until, sleep } from './harness';
import { BcClient } from './client';
import { CLS_CAMERA } from '../../src/baichuan/frame';
import { PUSHES } from '../../src/baichuan/xml';
import { createCameraApp } from '../../src/camera-api/app';
import { login } from '../helpers';

afterEach(closeAll);

// Refused or dropped before any reply: the connect fails, or the first
// request finds the connection closed.
async function refused(connect: () => Promise<BcClient>): Promise<boolean> {
  let c: BcClient;
  try {
    c = await connect();
  } catch {
    return true;
  }
  await c.nonceRequest().catch(() => undefined);
  return c.closed && c.frames.length === 0;
}

describe('Baichuan server: the session limit (session-limit.txt)', () => {
  it('takes 12 connections, bare ones included; the 13th is reset at its first message; a close frees a slot', async () => {
    const { connect, server } = await startBc();
    const bare: BcClient[] = [];
    for (let i = 0; i < 12; i++) bare.push(await connect());
    await until(() => server.connectionCount() === 12);
    const thirteenth = await connect();
    await expect(thirteenth.nonceRequest()).rejects.toThrow(/closed/);
    expect(await thirteenth.ended).toBe('reset');
    expect(thirteenth.frames).toHaveLength(0);
    bare[0].close();
    await until(() => server.connectionCount() === 11);
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });

  it('HTTP logins work while port 9000 is full', async () => {
    const { connect, server, engine } = await startBc();
    for (let i = 0; i < 12; i++) await connect();
    await until(() => server.connectionCount() === 12);
    expect(await login(createCameraApp(engine, { port: 'http' }))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('baichuan.sessionLimit lowers the limit', async () => {
    const { connect, loggedIn, engine } = await startBc();
    engine.faults.set({ name: 'baichuan.sessionLimit', max: 2 });
    await loggedIn();
    await loggedIn();
    const third = await connect();
    await expect(third.nonceRequest()).rejects.toThrow(/closed/);
    expect(await third.ended).toBe('reset');
    engine.faults.clear('baichuan.sessionLimit');
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });
});

describe('Baichuan server: idle timeouts (idle.txt), shortened', () => {
  it('closes a connection that never sends after firstMessageMs', async () => {
    const { connect } = await startBc({ firstMessageMs: 300, idleMs: 5000 });
    const t0 = Date.now();
    const c = await connect();
    expect(await c.ended).toBe('eof');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('closes a logged-in session idleMs after its last message; cmd 93 and a 405 reset the timer', async () => {
    const { loggedIn } = await startBc({ firstMessageMs: 5000, idleMs: 600 });
    const a = await loggedIn();
    const t0 = Date.now();
    const b = await loggedIn();
    const c = await loggedIn();
    await sleep(400);
    await b.call(93);
    await c.call(4000);
    expect(await a.ended).toBe('eof');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(b.closed).toBe(false);
    expect(c.closed).toBe(false);
    expect(await b.ended).toBe('eof');
    expect(await c.ended).toBe('eof');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
});

describe('Baichuan server: pushes after login (idle.txt)', () => {
  it('sends the eight pushes once (message id 0), before the reply to the next request', async () => {
    const { loggedIn } = await startBc();
    const c = await loggedIn();
    const after = c.frames.findIndex((f) => f.header.cmd === 1 && f.header.status === 200) + 1; // right after the login reply
    const id = c.send(93);
    const at = await c.waitIndex((f) => f.header.cmd === 93 && f.header.msgId === id);
    const pushes = c.frames.slice(after, at);
    expect(pushes.map((f) => f.header.cmd)).toEqual(PUSHES.map((p) => p.cmd));
    for (const [i, f] of pushes.entries()) {
      expect(f.header).toMatchObject({ msgId: 0, status: 200, cls: CLS_CAMERA, payloadOffset: 0 });
      expect(c.text(f)).toBe(PUSHES[i].xml);
    }
    await sleep(700);
    expect(c.frames.filter((f) => f.header.msgId === 0)).toHaveLength(8);
  });

  it('sends them by themselves within half a second when no request comes', async () => {
    const { loggedIn } = await startBc();
    const c = await loggedIn();
    const t0 = Date.now();
    await c.waitFor((f) => f.header.cmd === 669, 2000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.frames.filter((f) => f.header.msgId === 0).map((f) => f.header.cmd)).toEqual([78, 79, 464, 547, 291, 677, 600, 669]);
  });
});

describe('Baichuan server: the device state', () => {
  it('offline drops the connections and refuses new ones until cleared', async () => {
    const { loggedIn, connect, engine } = await startBc();
    const c = await loggedIn();
    engine.faults.set({ name: 'offline' });
    expect(['eof', 'reset']).toContain(await c.ended);
    await until(() => engine.counters.baichuanSessions === 0);
    expect(await refused(connect)).toBe(true);
    engine.faults.clear('offline');
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });

  it('power-off drops and refuses; power-on brings it back', async () => {
    const { loggedIn, connect, engine } = await startBc();
    const c = await loggedIn();
    expect(engine.powerOff()).toBe(true);
    expect(['eof', 'reset']).toContain(await c.ended);
    expect(await refused(connect)).toBe(true);
    await engine.powerOn(0);
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });

  it('reboot drops the connections and refuses new ones while booting', async () => {
    const { loggedIn, connect, engine } = await startBc();
    const c = await loggedIn();
    const booting = engine.reboot({ ms: 300 });
    expect(['eof', 'reset']).toContain(await c.ended);
    expect(await refused(connect)).toBe(true);
    await booting;
    expect((await (await connect()).login('proxy', 'proxy-pw')).header.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/baichuan/session.test.ts test/baichuan/connections.test.ts`
Expected: FAIL. `../../src/baichuan/server` cannot be resolved; the trace-only test "the test client sends what the traces show" passes.

- [ ] **Step 4: Implement**

`src/baichuan/server.ts`:

```ts
// cam-sim's Baichuan server (the camera's TCP port 9000): connections, login,
// sessions, and (vod.ts) recordings download. It answers like the RLC-1224A
// in reference/rlc-1224a/baichuan/. Protocol after reolink_aio 5d37cb3 and
// PR #186 9a1bb52 (MIT, THIRD_PARTY_NOTICES). Nothing here logs a body, a
// password, a nonce or a key.
import net, { type AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import type { Engine } from '../engine/engine';
import { BAICHUAN_SESSION_LIMIT, type User } from '../config';
import { CLS_CAMERA, CLS_NONCE_REPLY, CLS_NONCE_REQUEST, ENC_CHOICE, FrameParser, channelOf, encodeFrame, type BcFrame } from './frame';
import { aesEncrypt, aesKey, bcXor, md5_31 } from './cipher';
import { LINK_TYPE_XML, LOGIN_ERR_XML, PUSHES, loginReplyXml, nonceXml, tagValue, type PushMessage } from './xml';

export interface BaichuanOptions {
  idleMs?: number; // default config.baichuan.idleMs (32 s)
  firstMessageMs?: number; // default config.baichuan.firstMessageMs (12.5 s)
}

// What the server needs of a connection's running download (vod.ts).
export interface TransferLike {
  readonly done: boolean;
  cancel(): void; // stop at once, without a message (a new cmd 8 replaced it)
  stop(): void; // cmd 9: the frames already in flight, then nothing
}

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
  pendingPushes: PushMessage[] = [];
  transfer?: TransferLike;

  constructor(readonly socket: net.Socket) {
    this.ip = socket.remoteAddress ?? '';
  }
}

type Log = (status: number, replyLen?: number) => void;

// The traced nonce is 29 characters; its alphabet was redacted.
const newNonce = () => randomBytes(15).toString('hex').toUpperCase().slice(0, 29);

export class BaichuanServer {
  private readonly server: net.Server;
  private readonly conns = new Set<Conn>();
  private readonly idleMs: number;
  private readonly firstMessageMs: number;
  private readonly hooks = { dropAll: () => this.dropAll(), dropTransfers: () => this.dropTransfers() };
  private readonly onFaults = () => {
    if (this.down()) this.dropAll();
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

  dropAll(): void {
    for (const c of this.conns) c.socket.destroy();
  }

  // downloads.dropActive: a running transfer's connection closes.
  dropTransfers(): void {
    for (const c of this.conns) {
      if (!c.transfer || c.transfer.done) continue;
      this.engine.counters.droppedBaichuanDownloads++;
      c.socket.destroy();
    }
  }

  // Powered off, rebooting or the offline fault: port 9000 is down too.
  private down(): boolean {
    const e = this.engine;
    return e.power !== 'on' || e.rebooting || !!e.faults.active('offline');
  }

  private limit(): number {
    return this.engine.faults.active('baichuan.sessionLimit')?.max ?? BAICHUAN_SESSION_LIMIT;
  }

  private accept(socket: net.Socket): void {
    socket.on('error', () => undefined);
    if (this.down()) return void socket.resetAndDestroy();
    const c = new Conn(socket);
    // Measured: connections over the limit are accepted, then reset at their
    // first message; connections that never logged in count too.
    let counted = 0;
    for (const x of this.conns) if (x.counted) counted++;
    c.counted = counted < this.limit();
    this.conns.add(c);
    this.armIdle(c, this.firstMessageMs);
    socket.on('data', (d: Buffer) => this.onData(c, d));
    socket.on('close', () => this.onClose(c));
  }

  private onData(c: Conn, data: Buffer): void {
    if (c.closed || c.ending) return;
    if (!c.counted || this.down()) return void c.socket.resetAndDestroy();
    let frames: BcFrame[];
    try {
      frames = c.parser.push(data);
    } catch {
      // Measured: bad magic closes the connection without a reply.
      return void c.socket.destroy();
    }
    for (const f of frames) {
      if (c.closed || c.ending || c.socket.destroyed) return;
      this.handle(c, f);
    }
  }

  private onClose(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    clearTimeout(c.idle);
    for (const t of c.pushTimers) clearTimeout(t);
    c.transfer?.cancel();
    this.conns.delete(c);
    if (c.sessionId !== undefined) {
      this.engine.sessions.closeBaichuan(c.sessionId);
      this.engine.counters.baichuanSessions--;
    }
  }

  // Measured: about 32 s after the client's last message, 12.5 s for a
  // connection that never sends. A running download keeps it open (chosen).
  private armIdle(c: Conn, ms: number): void {
    clearTimeout(c.idle);
    c.idle = setTimeout(() => {
      if (c.transfer && !c.transfer.done) return this.armIdle(c, ms);
      c.socket.destroy();
    }, ms);
    c.idle.unref();
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
    this.flushPushes(c);
    switch (cmd) {
      case 2: {
        // Logout: 200, then the camera closes the connection.
        log(200, this.reply(c, cmd, msgId, 200));
        c.ending = true;
        c.transfer?.cancel();
        c.socket.destroySoon();
        return;
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
    const refused = !!this.engine.faults.consume('baichuan.loginFail');
    const user = refused ? undefined : this.engine.sessions.findUser((u) => md5_31(u.name + nonce) === userHash && md5_31(u.password + nonce) === passHash);
    if (!user) {
      // Measured: 401 with remainTimes 10; the connection stays open.
      const body = bcXor(Buffer.from(LOGIN_ERR_XML), ch);
      this.send(c, encodeFrame({ cmd, msgId, status: 401, cls: CLS_CAMERA, body }));
      return log(401, body.length);
    }
    c.user = user;
    c.key = aesKey(nonce, user.password);
    c.sessionId = this.engine.sessions.openBaichuan(user, c.ip);
    this.engine.counters.baichuanSessions++;
    this.engine.counters.baichuanLogins++;
    const body = bcXor(Buffer.from(loginReplyXml(randomBytes(8).toString('hex'), randomBytes(8).toString('hex'))), ch);
    this.send(c, encodeFrame({ cmd, msgId, status: 200, cls: CLS_CAMERA, body }));
    log(200, body.length);
    this.schedulePushes(c);
  }

  // Measured: after a login the camera sends these unsolicited (message id 0,
  // channel 0, status 200), 0.04-0.5 s later. Pushes still unsent when the
  // next request arrives go out before its reply, between the two.
  private schedulePushes(c: Conn): void {
    c.pendingPushes = [...PUSHES];
    for (const ms of new Set(PUSHES.map((p) => p.afterMs))) {
      const t = setTimeout(() => this.sendPushes(c, (p) => p.afterMs <= ms), ms);
      t.unref();
      c.pushTimers.push(t);
    }
  }

  private sendPushes(c: Conn, pick: (p: PushMessage) => boolean): void {
    if (!c.key || c.closed) return;
    const now = c.pendingPushes.filter(pick);
    c.pendingPushes = c.pendingPushes.filter((p) => !pick(p));
    for (const p of now) this.send(c, encodeFrame({ cmd: p.cmd, msgId: 0, status: 200, cls: CLS_CAMERA, body: aesEncrypt(c.key, Buffer.from(p.xml)) }));
  }

  private flushPushes(c: Conn): void {
    if (c.pendingPushes.length) this.sendPushes(c, () => true);
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
```

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run test/baichuan/ && npm run lint:types`
Expected: PASS, every Baichuan test so far. No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/baichuan/server.ts test/baichuan/client.ts test/baichuan/harness.ts test/baichuan/session.test.ts test/baichuan/connections.test.ts
git commit -m "feat(baichuan): server with login, sessions, limit, idle closes and pushes"
```

---

### Task 6: Recordings over Baichuan (cmds 8, 9, 13)

**Files:**
- Create: `src/baichuan/vod.ts`
- Modify: `src/baichuan/server.ts` (imports, three cases in `handle()`, `requestXml()`, `download()`, the `drained()` helper)
- Test: `test/baichuan/vod.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `encodeFrame`, `CLS_CAMERA`.
  - Task 2: `aesEncrypt`, `aesDecrypt`, `encryptChunk`.
  - Task 3: `EXT_BINARY`, `EXT_CHUNK`, `ENCRYPT_LEN`, `fileInfoXml`, `Moment`, `tagValue`, `infoRecord`, `chunkSize`, `chunkSizes`.
  - Task 4: the counters and faults.
  - Task 5: `TransferLike`, `BaichuanServer`, the harness and the client.
  - `Engine.sd.byName`, `Engine.mediaFor`, `ENC` from `src/profile/rlc1224a.ts`.
- Produces (from `src/baichuan/vod.ts`):
  - `FRAMES_AFTER_STOP = 13`, `FIRST_REPLY_LEN = 138`
  - `interface BcFile { path: string; size: number; stream: Stream; start: Moment; end: Moment }`
  - `timesOf(rec: Recording, stream: Stream): { start: Moment; end: Moment }`
  - `resolveFile(e: Engine, id: string | undefined): BcFile | undefined`
  - `fileInfoReply(e: Engine, id: string | undefined, name: string | undefined): { status: number; xml?: string }`
  - `interface TransferDeps`, and `class Transfer implements TransferLike { done; cancel(); stop(); run(): Promise<'complete' | 'stopped' | 'dropped'> }`

- [ ] **Step 1: Write the failing test**

`test/baichuan/vod.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { startBc, closeAll, until, sleep, track, DEMO } from './harness';
import { downloadXml, fileInfoRequestXml, stopXml, type BcClient } from './client';
import { aesEncrypt } from '../../src/baichuan/cipher';
import { EXT_BINARY, EXT_CHUNK, tagValue } from '../../src/baichuan/xml';
import { chunkSizes, infoRecord } from '../../src/baichuan/records';
import { resolveFile, timesOf } from '../../src/baichuan/vod';
import { createCameraApp } from '../../src/camera-api/app';
import { listen, login, rawGet } from '../helpers';
import type { Engine } from '../../src/engine/engine';

afterEach(closeAll);

const sizeFromName = (name: string) => parseInt(/_([0-9A-F]+)\.mp4$/.exec(name)![1], 16);

// The same file over HTTP Download (the reference for byte equality).
async function withHttp(engine: Engine) {
  const app = createCameraApp(engine, { port: 'http' });
  const srv = await listen(app);
  track(srv.close);
  const t = await login(app);
  const url = (name: string) => `${srv.url}/cgi-bin/api.cgi?cmd=Download&source=${name}&output=x.mp4&token=${t}`;
  return { url, download: async (name: string) => Buffer.from(await (await fetch(url(name))).arrayBuffer()) };
}

const framesOf = (c: BcClient, msgId: number) => c.frames.filter((f) => f.header.cmd === 8 && f.header.msgId === msgId);

describe('Baichuan recordings: files', () => {
  it('names, Search sizes and file sizes agree for every seeded recording', async () => {
    const { engine } = await startBc({ env: DEMO });
    const recs = engine.sd.all();
    expect(recs).toHaveLength(6);
    for (const rec of recs) {
      for (const s of ['sub', 'main'] as const) {
        const f = rec.files[s];
        const day = { year: Number(rec.date.slice(0, 4)), mon: Number(rec.date.slice(5, 7)), day: Number(rec.date.slice(8, 10)), hour: 0, min: 0, sec: 0 };
        const listed = engine.sd.search(s, day, { ...day, hour: 23, min: 59, sec: 59 }).find((x) => x.name === f.name);
        expect(sizeFromName(f.name)).toBe(f.size);
        expect(Number(listed?.size)).toBe(f.size);
        expect(resolveFile(engine, f.name)?.size).toBe(f.size);
      }
    }
  });
});

describe('Baichuan recordings: cmd 8', () => {
  it('sub and main downloads equal the HTTP Download, after the 32-byte record; chunks as traced (vod-nosearch.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    for (const s of ['sub', 'main'] as const) {
      const { name, size } = rec.files[s];
      const r = await c.download(name, size);
      expect(r.status).toBe(200);
      expect(r.data.length).toBe(size);
      expect(r.data.equals(await http.download(name))).toBe(true);
      const main = s === 'main';
      expect(r.info).toEqual(infoRecord({ width: main ? 4512 : 896, height: main ? 2512 : 512, fps: main ? 20 : 10, main, ...timesOf(rec, s) }));
      const frames = framesOf(c, r.msgId);
      expect(frames[0].header).toMatchObject({ status: 200, payloadOffset: 106, bodyLen: 138 });
      expect(c.text(frames[0], 'ext')).toBe(EXT_BINARY);
      expect(frames.slice(1).map((f) => f.body.length)).toEqual(chunkSizes(size));
      for (const f of frames.slice(1)) {
        expect(f.header.payloadOffset).toBe(136);
        expect(c.text(f, 'ext')).toBe(EXT_CHUNK);
      }
      // Partial encryption: a chunk's first 1024 bytes are AES, the rest is the file as is.
      expect(frames[1].body.subarray(0, 1024)).toEqual(aesEncrypt(c.key!, r.data.subarray(0, 1024)));
      expect(frames[1].body.subarray(1024)).toEqual(r.data.subarray(1024, frames[1].body.length));
      expect((await c.call(9, stopXml())).header).toMatchObject({ status: 200, bodyLen: 0 });
    }
    expect(engine.counters.baichuanDownloads).toBe(2);
    expect(engine.requests.recent(20).find((x) => x.port === 'baichuan' && x.cmd === '8')).toMatchObject({ status: 200, replyLen: 138 });
  });

  it('a <name> in cmd 8 changes nothing', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    const plain = await c.download(rec.files.sub.name, rec.files.sub.size);
    const named = await c.download(rec.files.sub.name, rec.files.sub.size, { name: `01${rec.date.replaceAll('-', '')}${rec.start}` });
    expect(named.data.equals(plain.data)).toBe(true);
  });

  it('an unknown file answers 400 with no body and no chunks; baichuan.refuse does the same (err-notfound.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const c = await loggedIn();
    const r = await c.download('/mnt/sda/Mp4Record/2026-10-02/nothing.mp4', 1);
    expect(r.status).toBe(400);
    expect(framesOf(c, r.msgId)[0].header.bodyLen).toBe(0);
    const { name, size } = engine.sd.all()[0].files.sub;
    engine.faults.set({ name: 'baichuan.refuse', count: 1 });
    expect((await c.download(name, size)).status).toBe(400);
    await sleep(300);
    expect(c.frames.filter((f) => f.header.cmd === 8 && f.header.status === 200)).toHaveLength(0);
    expect((await c.download(name, size)).status).toBe(200);
    expect(engine.counters.baichuanDownloads).toBe(1);
  });
});

describe('Baichuan recordings: stop, replace, parallel', () => {
  it('cmd 9 answers 200; 13 more chunks follow under the old id, then nothing; the next cmd 8 works (abort.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    engine.faults.set({ name: 'baichuan.delayMs', ms: 20 });
    const old = c.send(8, downloadXml(rec.files.main.name));
    let i = 0;
    for (let n = 0; n < 6; n++) i = (await c.waitIndex((f) => f.header.msgId === old, 3000, i)) + 1; // the record and 5 chunks
    const stop = c.send(9, stopXml());
    const at = await c.waitIndex((f) => f.header.cmd === 9 && f.header.msgId === stop);
    expect(c.frames[at].header).toMatchObject({ status: 200, bodyLen: 0 });
    await sleep(800);
    expect(c.frames.slice(at + 1).filter((f) => f.header.msgId === old)).toHaveLength(13);
    expect(framesOf(c, old).length - 1).toBeLessThan(chunkSizes(rec.files.main.size).length);
    engine.faults.clear('baichuan.delayMs');
    const next = await c.download(rec.files.sub.name, rec.files.sub.size);
    expect(next.data.equals(await http.download(rec.files.sub.name))).toBe(true);
  });

  it('a second cmd 8 on the connection silently replaces the running one (err-second-download.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    engine.faults.set({ name: 'baichuan.delayMs', ms: 10 });
    const first = c.send(8, downloadXml(rec.files.main.name));
    await c.waitIndex((f) => f.header.msgId === first && f.header.payloadOffset === 136);
    const r = await c.download(rec.files.sub.name, rec.files.sub.size);
    expect(r.data.equals(await http.download(rec.files.sub.name))).toBe(true);
    const firstNew = c.frames.findIndex((f) => f.header.msgId === r.msgId);
    expect(c.frames.slice(firstNew).some((f) => f.header.msgId === first)).toBe(false);
    expect(framesOf(c, first).length - 1).toBeLessThan(chunkSizes(rec.files.main.size).length);
  });

  it('two connections download in parallel', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const { name, size } = engine.sd.all()[0].files.main;
    const expected = await http.download(name);
    engine.faults.set({ name: 'baichuan.delayMs', ms: 5 });
    const a = await loggedIn();
    const b = await loggedIn();
    const [ra, rb] = await Promise.all([a.download(name, size, { ms: 10_000 }), b.download(name, size, { ms: 10_000 })]);
    expect(ra.data.equals(expected)).toBe(true);
    expect(rb.data.equals(expected)).toBe(true);
    const at = (c: BcClient, id: number) => c.times.filter((_, k) => c.frames[k].header.msgId === id);
    const ta = at(a, ra.msgId);
    const tb = at(b, rb.msgId);
    expect(tb[0]).toBeLessThan(ta[ta.length - 1]);
    expect(ta[0]).toBeLessThan(tb[tb.length - 1]);
  });
});

describe('Baichuan recordings: cmd 13', () => {
  it('the Id size without <name>, the MAIN size with it, handle 0; 431 and 400 for unknown files (fileinfo.txt, err-notfound.txt)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const rec = engine.sd.all()[0];
    const c = await loggedIn();
    const startName = `01${rec.date.replaceAll('-', '')}${rec.start}`;
    const info = async (id: string, name?: string) => {
      const f = await c.call(13, fileInfoRequestXml(id, name));
      return { status: f.header.status, xml: c.text(f) };
    };
    const sub = await info(rec.files.sub.name);
    expect(sub.status).toBe(200);
    expect(tagValue(sub.xml, 'sizeL')).toBe(String(rec.files.sub.size));
    expect(tagValue(sub.xml, 'sizeH')).toBe('0');
    expect(tagValue(sub.xml, 'handle')).toBe('0');
    expect(tagValue(sub.xml, 'name')).toBe('');
    const subNamed = await info(rec.files.sub.name, startName);
    expect(tagValue(subNamed.xml, 'sizeL')).toBe(String(rec.files.main.size));
    expect(tagValue(subNamed.xml, 'name')).toBe(startName);
    expect(tagValue((await info(rec.files.main.name)).xml, 'sizeL')).toBe(String(rec.files.main.size));
    expect(await info('/mnt/sda/Mp4Record/2026-10-02/nothing.mp4')).toEqual({ status: 431, xml: '' });
    expect(await info('/mnt/sda/Mp4Record/2026-10-02/nothing.mp4', '0120200101013000')).toEqual({ status: 400, xml: '' });
  });
});

describe('Baichuan recordings: faults and device actions', () => {
  it('baichuan.dropMidway closes the connection halfway through', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const { name, size } = engine.sd.all()[0].files.main;
    engine.faults.set({ name: 'baichuan.dropMidway' });
    const c = await loggedIn();
    await expect(c.download(name, size)).rejects.toThrow(/closed/);
    const got = c.frames.filter((f) => f.header.cmd === 8).slice(1).reduce((n, f) => n + f.body.length, 0);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThanOrEqual(size / 2);
    expect(engine.counters.droppedBaichuanDownloads).toBe(1);
  });

  it('baichuan.delayMs waits before each chunk', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const { name, size } = engine.sd.all()[0].files.sub;
    engine.faults.set({ name: 'baichuan.delayMs', ms: 30 });
    const c = await loggedIn();
    const t0 = Date.now();
    expect((await c.download(name, size, { ms: 5000 })).data.length).toBe(size);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30 * chunkSizes(size).length - 10);
  });

  it('downloads.dropActive also cuts Baichuan transfers', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const { name } = engine.sd.all()[0].files.main;
    engine.faults.set({ name: 'baichuan.delayMs', ms: 20 });
    const c = await loggedIn();
    const id = c.send(8, downloadXml(name));
    await c.waitIndex((f) => f.header.msgId === id && f.header.payloadOffset === 136);
    engine.dropDownloads();
    expect(['eof', 'reset']).toContain(await c.ended);
    expect(engine.counters.droppedBaichuanDownloads).toBe(1);
  });

  it('with downloads.refuse on, HTTP Download resets and Baichuan still works', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO });
    const http = await withHttp(engine);
    const { name, size } = engine.sd.all()[0].files.sub;
    engine.faults.set({ name: 'downloads.refuse' });
    expect(await rawGet(http.url(name))).toBe('reset');
    const r = await (await loggedIn()).download(name, size);
    expect(r.status).toBe(200);
    expect(r.data.length).toBe(size);
    expect(engine.counters.downloads).toBe(0);
    expect(engine.counters.baichuanDownloads).toBe(1);
  });

  it('a running download keeps the connection open past the idle time (chosen, not measured)', async () => {
    const { engine, loggedIn } = await startBc({ env: DEMO, idleMs: 300 });
    const { name, size } = engine.sd.all()[0].files.main;
    engine.faults.set({ name: 'baichuan.delayMs', ms: 10 }); // about 70 chunks: far past 300 ms
    const c = await loggedIn();
    expect((await c.download(name, size, { ms: 5000 })).data.length).toBe(size);
    expect(await c.ended).toBe('eof'); // then the idle close
  });
});

describe('Baichuan recordings: backpressure', () => {
  // The main fixture (about 2.3 MB) is larger than the loopback buffers on
  // macOS and Linux, so a paused reader makes the transfer wait for drain.
  it('a reader that stops reading slows the transfer instead of growing the buffer', async () => {
    const { engine, loggedIn, server } = await startBc({ env: DEMO });
    const { name, size } = engine.sd.all()[0].files.main;
    const c = await loggedIn();
    c.socket.pause();
    const id = c.send(8, downloadXml(name));
    await until(() => server.writeBacklog() > 0, 3000);
    let max = 0;
    for (let k = 0; k < 25; k++) {
      await sleep(20);
      max = Math.max(max, server.writeBacklog());
    }
    expect(max).toBeLessThan(128 * 1024);
    c.socket.resume();
    expect((await c.collect(id, size)).data.length).toBe(size);
  });

  // Review Focus 3.
  it('a client that disappears while its transfer waits for drain: the transfer ends and the session goes', async () => {
    const { engine, loggedIn, server } = await startBc({ env: DEMO });
    const { name } = engine.sd.all()[0].files.main;
    const c = await loggedIn();
    c.socket.pause();
    c.send(8, downloadXml(name));
    await until(() => server.writeBacklog() > 0, 3000);
    c.close();
    await until(() => server.connectionCount() === 0);
    expect(engine.counters.baichuanSessions).toBe(0);
    expect(engine.sessions.online()).toEqual([]);
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/baichuan/vod.test.ts`
Expected: FAIL, `../../src/baichuan/vod` not found.

- [ ] **Step 3: Implement `src/baichuan/vod.ts`**

```ts
// Recordings over Baichuan: the file behind an <Id>, cmd 13's file info, and
// a cmd-8 transfer (the info record, then the chunks), as measured on the
// RLC-1224A (reference/rlc-1224a/baichuan/: vod-*.txt, fileinfo.txt,
// abort.txt). After PR #186 9a1bb52 to reolink_aio (MIT, THIRD_PARTY_NOTICES).
import { open } from 'fs/promises';
import type { Engine } from '../engine/engine';
import type { Recording, Stream } from '../engine/sdcard';
import { ENC } from '../profile/rlc1224a';
import { CLS_CAMERA, encodeFrame } from './frame';
import { aesEncrypt, encryptChunk } from './cipher';
import { ENCRYPT_LEN, EXT_BINARY, EXT_CHUNK, fileInfoXml, type Moment } from './xml';
import { chunkSize, infoRecord } from './records';
import type { TransferLike } from './server';

// Measured: about 400 KB (13 frames) still arrive after cmd 9.
export const FRAMES_AFTER_STOP = 13;
// The first cmd-8 reply's body: the 106-byte extension and the 32-byte record.
export const FIRST_REPLY_LEN = Buffer.byteLength(EXT_BINARY) + 32;

export interface BcFile {
  path: string;
  size: number;
  stream: Stream;
  start: Moment;
  end: Moment;
}

const moment = (date: string, hms: string): Moment => ({
  year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)),
  hour: Number(hms.slice(0, 2)), minute: Number(hms.slice(2, 4)), second: Number(hms.slice(4, 6)),
});

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Camera-local start and end; a clip across midnight ends the next day.
export function timesOf(rec: Recording, stream: Stream): { start: Moment; end: Moment } {
  const end = (stream === 'main' ? (rec.mainEnd ?? rec.end) : rec.end) ?? rec.start;
  return { start: moment(rec.date, rec.start), end: moment(end < rec.start ? nextDay(rec.date) : rec.date, end) };
}

// The file behind cmd 8's <Id>: exactly a name that HTTP Search lists.
export function resolveFile(e: Engine, id: string | undefined): BcFile | undefined {
  const found = id ? e.sd.byName(id) : undefined;
  if (!found) return undefined;
  const media = e.mediaFor(found.rec);
  return { path: media.clipPath(found.stream), size: media.clipSize(found.stream), stream: found.stream, ...timesOf(found.rec, found.stream) };
}

// cmd 13. Measured: without <name> it reports the <Id>'s size; with <name>
// (01YYYYMMDDhhmmss) it finds the recording by its start time and reports
// the MAIN file's size, also for a sub <Id>. handle is always 0. A file it
// doesn't know: 431 without <name>, 400 with it.
export function fileInfoReply(e: Engine, id: string | undefined, name: string | undefined): { status: number; xml?: string } {
  if (name !== undefined) {
    const m = /^\d{2}(\d{4})(\d{2})(\d{2})(\d{6})$/.exec(name);
    const rec = m ? e.sd.all().find((r) => r.date === `${m[1]}-${m[2]}-${m[3]}` && r.start === m[4]) : undefined;
    if (!rec) return { status: 400 };
    return { status: 200, xml: fileInfoXml({ name, size: rec.files.main.size, ...timesOf(rec, 'main') }) };
  }
  const found = id ? e.sd.byName(id) : undefined;
  if (!found) return { status: 431 };
  return { status: 200, xml: fileInfoXml({ name: '', size: found.rec.files[found.stream].size, ...timesOf(found.rec, found.stream) }) };
}

export interface TransferDeps {
  file: BcFile;
  msgId: number;
  key: Buffer;
  write(frame: Buffer): boolean; // false: wait for drained()
  drained(): Promise<void>;
  alive(): boolean;
  delayMs(): number | undefined; // baichuan.delayMs, read before each chunk
  dropMidway(): boolean; // baichuan.dropMidway, read at the start
  onDrop(): void; // closes the connection
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One cmd-8 transfer. Every frame echoes cmd 8's message id; there is no
// terminator. It reads one chunk at a time and waits for the socket to drain,
// so a slow reader slows it down instead of growing a buffer.
export class Transfer implements TransferLike {
  done = false;
  private cancelled = false;
  private tail?: number; // frames still allowed after cmd 9

  constructor(private readonly d: TransferDeps) {}

  cancel(): void {
    this.cancelled = true;
  }

  stop(): void {
    if (this.tail === undefined) this.tail = FRAMES_AFTER_STOP;
  }

  async run(): Promise<'complete' | 'stopped' | 'dropped'> {
    try {
      return await this.send();
    } finally {
      this.done = true;
    }
  }

  // May the next frame go out? Checked right before each write, so every
  // frame written after cmd 9 counts toward the tail.
  private go(): boolean {
    if (this.cancelled || !this.d.alive()) return false;
    if (this.tail === undefined) return true;
    if (this.tail <= 0) return false;
    this.tail--;
    return true;
  }

  private async write(frame: Buffer): Promise<void> {
    if (!this.d.write(frame) && this.d.alive()) await this.d.drained();
  }

  private async send(): Promise<'complete' | 'stopped' | 'dropped'> {
    const { file, msgId, key } = this.d;
    const fh = await open(file.path, 'r');
    try {
      const enc = ENC[file.stream === 'main' ? 'mainStream' : 'subStream'];
      const record = infoRecord({ width: enc.width, height: enc.height, fps: enc.frameRate, main: file.stream === 'main', start: file.start, end: file.end });
      if (!this.go()) return 'stopped';
      await this.write(encodeFrame({ cmd: 8, msgId, status: 200, cls: CLS_CAMERA, ext: aesEncrypt(key, Buffer.from(EXT_BINARY)), body: record }));
      const ext = aesEncrypt(key, Buffer.from(EXT_CHUNK));
      const half = this.d.dropMidway() ? Math.floor(file.size / 2) : Infinity;
      let sent = 0;
      for (let i = 0; sent < file.size; i++) {
        const n = chunkSize(i, file.size - sent);
        if (sent + n > half) {
          this.d.onDrop();
          return 'dropped';
        }
        const ms = this.d.delayMs();
        if (ms) await sleep(ms);
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, sent);
        if (bytesRead !== n) throw new Error('the recording file changed during a transfer');
        if (!this.go()) return 'stopped';
        await this.write(encodeFrame({ cmd: 8, msgId, status: 200, cls: CLS_CAMERA, ext, body: encryptChunk(key, buf, ENCRYPT_LEN) }));
        sent += n;
      }
      return 'complete';
    } finally {
      await fh.close();
    }
  }
}
```

- [ ] **Step 4: Wire cmds 8, 9 and 13 into `src/baichuan/server.ts`**

- Change the cipher import to `import { aesDecrypt, aesEncrypt, aesKey, bcXor, md5_31 } from './cipher';` and add:

```ts
import { FIRST_REPLY_LEN, Transfer, fileInfoReply, resolveFile } from './vod';
```

- In `handle()`, insert these cases before `case 93:`:

```ts
      case 8:
        return this.download(c, f, log);
      case 9:
        // Stop: 200 at once; the chunks in flight still come (vod.ts).
        c.transfer?.stop();
        return log(200, this.reply(c, cmd, msgId, 200));
      case 13: {
        const xml = this.requestXml(c, f);
        const r = fileInfoReply(this.engine, tagValue(xml, 'Id'), tagValue(xml, 'name') || undefined);
        return log(r.status, this.reply(c, cmd, msgId, r.status, r.xml));
      }
```

- Add these methods to `BaichuanServer`, after `login()`:

```ts
  // The body of a request after login (AES from the fixed IV).
  private requestXml(c: Conn, f: BcFrame): string {
    return f.body.length ? aesDecrypt(c.key!, f.body).toString('utf8') : '';
  }

  private download(c: Conn, f: BcFrame, log: Log): void {
    const { msgId } = f.header;
    const file = resolveFile(this.engine, tagValue(this.requestXml(c, f), 'Id'));
    // Measured: a refusal and a missing file look alike: 400, no body, no chunks.
    if (this.engine.faults.consume('baichuan.refuse') || !file) return log(400, this.reply(c, 8, msgId, 400));
    // Measured: a new cmd 8 silently replaces the running one.
    c.transfer?.cancel();
    this.engine.counters.baichuanDownloads++;
    const socket = c.socket;
    const t = new Transfer({
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
      this.engine.log.warn({ err: err.message }, 'baichuan_transfer_failed');
      socket.destroy();
    });
  }
```

- Add at the end of the file:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/baichuan/ && npm run lint:types`
Expected: PASS, all Baichuan tests including `vod.test.ts`. No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/baichuan/vod.ts src/baichuan/server.ts test/baichuan/vod.test.ts
git commit -m "feat(baichuan): download (cmd 8), stop (9) and file info (13)"
```

---

### Task 7: Wiring: `createCamSim`, the CLI, the container

**Files:**
- Modify: `src/index.ts` (`Ports`, `listen`, `close`), `Dockerfile`, `compose.yaml`, `scripts/container-smoke.sh`, `e2e/env.ts`
- Test: `test/index.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: Task 5's `BaichuanServer` (`listen`, `close`); Task 4's `config.ports.baichuan`, `CamSimOptions.baichuan`; the test client.
- Produces: `Ports.baichuan: number`. `CamSim.listen(ports?: Partial<Ports>, host?)` also returns `baichuan`, a free port in process unless named. `CamSim.close()` ends Baichuan connections.

- [ ] **Step 1: Write the failing tests**

`test/index.test.ts`: add imports

```ts
import { BcClient, downloadXml } from './baichuan/client';
```

and append a new describe at the end:

```ts
describe('createCamSim: Baichuan', () => {
  const ALL0 = { http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 };

  // Review Focus 1.
  it('opens a free Baichuan port unless one is named, so simulators side by side never collide', async () => {
    const a = await make();
    const b = await make();
    const [pa, pb] = await Promise.all([a.listen(ALL0, '127.0.0.1'), b.listen(ALL0, '127.0.0.1')]);
    expect(pa.baichuan).toBeGreaterThan(0);
    expect(pb.baichuan).toBeGreaterThan(0);
    expect(pb.baichuan).not.toBe(pa.baichuan);
    const c = await BcClient.connect(pa.baichuan);
    expect((await c.login('u', 'p')).header.status).toBe(200);
    c.close();
  });

  // Review Focus 2.
  it('close() ends open Baichuan connections and a running transfer at once', async () => {
    const sim = await createCamSim({ users: [{ name: 'u', level: 'admin', password: 'p' }], seedClips: 'demo' });
    const ports = await sim.listen(ALL0, '127.0.0.1');
    sim.engine.faults.set({ name: 'baichuan.delayMs', ms: 50 });
    const c = await BcClient.connect(ports.baichuan);
    await c.login('u', 'p');
    const id = c.send(8, downloadXml(sim.engine.sd.all()[0].files.main.name));
    await c.waitIndex((f) => f.header.msgId === id);
    const t0 = Date.now();
    await sim.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(['eof', 'reset']).toContain(await c.ended);
  });

  it('takes shorter Baichuan idle times for tests (CamSimOptions.baichuan)', async () => {
    const sim = await make({ baichuan: { firstMessageMs: 200, idleMs: 300 } });
    const ports = await sim.listen(ALL0, '127.0.0.1');
    const t0 = Date.now();
    const c = await BcClient.connect(ports.baichuan);
    expect(await c.ended).toBe('eof');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
```

`test/cli.test.ts`: in the first test, replace the port lines and the `run(...)` call with:

```ts
    const [http, https, control, rtsp, onvif, baichuan] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];
    const p = run({ CAMSIM_USERS: 'u:admin:p', CAMSIM_HTTP_PORT: String(http), CAMSIM_HTTPS_PORT: String(https), CAMSIM_CONTROL_PORT: String(control), CAMSIM_RTSP_PORT: String(rtsp), CAMSIM_ONVIF_PORT: String(onvif), CAMSIM_BAICHUAN_PORT: String(baichuan) });
```

and after `await expect.poll(() => p.out(), { timeout: 15_000 }).toContain('cam_sim_listening');`, add:

```ts
    // The Baichuan port (CAMSIM_BAICHUAN_PORT) accepts connections.
    expect(await new Promise<boolean>((resolve) => {
      const s = net.connect(baichuan, '127.0.0.1', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    })).toBe(true);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/index.test.ts test/cli.test.ts`
Expected: FAIL. `pa.baichuan` is undefined, and the CLI's Baichuan port refuses the connection.

- [ ] **Step 3: Implement**

`src/index.ts`:
- Add `import { BaichuanServer } from './baichuan/server';`.
- In `interface Ports`, add `baichuan: number;`.
- In `createCamSim`, next to `let onvifApp…`, add `let baichuan: BaichuanServer | undefined;`.
- In `listen()`, after the ONVIF listener (`const onvifPort = …`), add:

```ts
      // Baichuan (the camera's port 9000): login and recordings download.
      baichuan = new BaichuanServer(engine);
      const baichuanPort = await baichuan.listen(p.baichuan, host);
```

  and return it: `return { ...camera.ports, control: controlPort, rtsp: rtsp.port(), onvif: onvifPort, baichuan: baichuanPort };`.
- In `close()`, after `await rtsp?.stop();`, add `await baichuan?.close();`. It runs before `engine.stop()`, so shutdown doesn't count transfers as dropped.

`Dockerfile`:
- Change `COPY openapi.yaml CHANGELOG.md ./` to `COPY openapi.yaml CHANGELOG.md THIRD_PARTY_NOTICES ./`.
- Change `EXPOSE 8443 8080 9443 8554 8000` to `EXPOSE 8443 8080 9443 8554 8000 9000`.

`compose.yaml`: add the Baichuan port to each camera's `ports`:
- cam2: `ports: ["127.0.0.1:8442:8443", "127.0.0.1:8082:8080", "127.0.0.1:9442:9443", "127.0.0.1:9002:9000"]`
- cam3: `ports: ["127.0.0.1:8443:8443", "127.0.0.1:8083:8080", "127.0.0.1:9443:9443", "127.0.0.1:9003:9000"]`
- cam4: `ports: ["127.0.0.1:8444:8443", "127.0.0.1:8084:8080", "127.0.0.1:9444:9443", "127.0.0.1:9004:9000"]`

`e2e/env.ts`: in `SIM_ENV`, after `CAMSIM_ONVIF_PORT: '18000',`, add `CAMSIM_BAICHUAN_PORT: '19000',`.

`scripts/container-smoke.sh`:
- Change the header comment's first line to `# Builds the image and checks it end to end: login over HTTPS, device info,`.
- Change its second line to `# live FLV, an event found by Search, its Download, and a Baichuan login. Throwaway secrets only.`
- Insert before the `# The SD pipeline:` block:

```bash
# Baichuan (port 9000): the nonce exchange and a login, from inside the
# container with the image's own frame codec and ciphers.
BC=$(docker exec -i -e BC_USER=smoke -e BC_PW="$PW" "$NAME" node - <<'JS'
const net = require('net');
const { encodeFrame, FrameParser, CLS_NONCE_REQUEST, CLS_CLIENT, ENC_OFFER } = require('/app/dist/src/baichuan/frame.js');
const { bcXor, md5_31 } = require('/app/dist/src/baichuan/cipher.js');
const s = net.connect(9000, '127.0.0.1');
const p = new FrameParser();
setTimeout(() => { console.log('timeout'); process.exit(1); }, 5000).unref();
s.on('error', (e) => { console.log(e.code); process.exit(1); });
s.on('connect', () => s.write(encodeFrame({ cmd: 1, msgId: 0x1fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST })));
s.on('data', (d) => {
  for (const f of p.push(d)) {
    if (f.header.msgId === 0x1fa) {
      const nonce = /<nonce>([^<]*)</.exec(bcXor(f.body, 250).toString())[1];
      const xml = ['<?xml version="1.0" encoding="UTF-8" ?>', '<body>', '<LoginUser version="1.1">',
        `<userName>${md5_31(process.env.BC_USER + nonce)}</userName>`, `<password>${md5_31(process.env.BC_PW + nonce)}</password>`,
        '<userVer>1</userVer>', '</LoginUser>', '<LoginNet version="1.1">', '<type>LAN</type>', '<udpPort>0</udpPort>', '</LoginNet>', '</body>']
        .map((l) => l + '\n').join('');
      s.write(encodeFrame({ cmd: 1, msgId: 0x2fa, status: 0, cls: CLS_CLIENT, body: bcXor(Buffer.from(xml), 250) }));
    } else if (f.header.msgId === 0x2fa) {
      console.log(f.header.status);
      s.destroy();
    }
  }
});
JS
)
[ "$BC" = 200 ] || fail "Baichuan login on 9000: $BC"
```

- [ ] **Step 4: Run the checks to verify they pass**

Run: `npx vitest run && npm run lint:types && npm run build && scripts/container-smoke.sh`
Expected: all tests PASS, no type errors, the build succeeds, `smoke: OK`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts Dockerfile compose.yaml scripts/container-smoke.sh e2e/env.ts test/index.test.ts test/cli.test.ts
git commit -m "feat(baichuan): open port 9000 in createCamSim, the CLI and the image"
```

---

### Task 8: Control API schema, Simulator page and docs

**Files:**
- Modify: `openapi.yaml`, `web/src/pages/Simulator.svelte`, `web/src/lib/state.ts`, `README.md`, `llms.txt`, `CHANGELOG.md`
- Test: `e2e/settings-simulator.spec.ts`

**Interfaces:**
- Consumes: the fault names and `max` (Task 4); the behaviour of Tasks 5–7, which the docs describe.
- Produces: the docs and the UI; no code interfaces.

- [ ] **Step 1: Write the failing e2e test**

`e2e/settings-simulator.spec.ts` already imports `TOKEN` and `UI_PORT` from `./env`. Append:

```ts
test('the Baichuan session limit fault takes its max from the page', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/#/simulator');
  const row = page.getByTestId('fault-baichuan.sessionLimit');
  await row.getByLabel('baichuan.sessionLimit max').fill('3');
  await row.getByTestId('fault-toggle').click();
  const faults = async () => (await request.get(`http://127.0.0.1:${UI_PORT}/sim/api/faults`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  await expect.poll(faults).toEqual([{ name: 'baichuan.sessionLimit', max: 3 }]);
  await expect(row).toContainText('max 3');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test e2e/settings-simulator.spec.ts -g "Baichuan session limit"`
Expected: FAIL. There is no element with test id `fault-baichuan.sessionLimit`.

- [ ] **Step 3: Implement the page**

`web/src/lib/state.ts`: in `SimState.faults`, add `max?: number` to the element type:

```ts
  faults: Array<{ name: string; count?: number; ms?: number; cmds?: string[]; rspCode?: number; max?: number }>;
```

`web/src/pages/Simulator.svelte`:
- Change the `FAULTS` type to `Array<{ name: string; label: string; params: Array<'ms' | 'count' | 'cmds' | 'rspCode' | 'max'> }>`.
- After the `rtsp.reset` entry, add:

```ts
    { name: 'baichuan.refuse', label: 'Baichuan downloads (cmd 8) answer 400, no chunks', params: [] },
    { name: 'baichuan.dropMidway', label: 'Baichuan downloads: the connection closes halfway', params: [] },
    { name: 'baichuan.delayMs', label: 'Wait before each Baichuan chunk', params: ['ms'] },
    { name: 'baichuan.loginFail', label: 'Baichuan logins answer 401 (remainTimes 10)', params: ['count'] },
    { name: 'baichuan.sessionLimit', label: 'At most N Baichuan connections (the camera allows 12)', params: ['max'] },
```

- Change the `params` state to:

```ts
  let params = $state<Record<string, { ms: number; count: number; cmds: string; rspCode: number; max: number }>>(
    Object.fromEntries(FAULTS.map((f) => [f.name, { ms: 1000, count: 1, cmds: 'SetWhiteLed', rspCode: -67, max: 2 }])),
  );
```

- In `toggleFault`, after the `rspCode` line, add `if (f.params.includes('max')) body.max = Number(p.max);`.
- In the fault row, change the description span to:

```svelte
            <span class="desc">{f.label}{#if on?.count !== undefined} · {on.count} left{/if}{#if on?.max !== undefined} · max {on.max}{/if}</span>
```

  and after the `rspCode` input line, add:

```svelte
              {#if f.params.includes('max')}<input type="number" min="1" bind:value={params[f.name].max} disabled={!!on} aria-label="{f.name} max" /> connections{/if}
```

- Change the button label `Drop downloads in flight` to `Drop downloads in flight (HTTP and Baichuan)`.

- [ ] **Step 4: Update `openapi.yaml`**

- In `components.schemas.Fault.properties.name.enum`, append `baichuan.refuse, baichuan.dropMidway, baichuan.delayMs, baichuan.loginFail, baichuan.sessionLimit`.
- After `rspCode: { type: integer }`, add:

```yaml
        max: { type: integer, minimum: 1, description: 'baichuan.sessionLimit only: Baichuan connections at once (the camera allows 12)' }
```

- Replace the `/sim/api/state` summary with:

```yaml
      summary: 'Identity, faults, recent events, SD card, counters (including baichuanSessions open now, baichuanLogins, baichuanDownloads, droppedBaichuanDownloads), running settings, the SD pipeline ({on:false[, error]} or {on:true, until, running}) and pipelineMaxMin (CAMSIM_PIPELINE_MAX_MIN)'
```

- In the `/sim/api/actions/{name}` summary, after `power-off drops every connection and ends sessions until power-on.`, add the line:

```yaml
        reboot and power-off also drop Baichuan (port 9000) connections; downloads.dropActive also cuts Baichuan transfers.
```

- Replace the `/sim/api/requests` summary with:

```yaml
      summary: 'Recent camera API requests (no query strings, no secrets); Baichuan messages have port baichuan, method BC, the cmd number, status and the body lengths len and replyLen'
```

- [ ] **Step 5: Update `README.md`**

- **Quick start:**
  - Change the `docker run` line to `docker run --rm -p 8443:8443 -p 8080:8080 -p 9443:9443 -p 8554:8554 -p 8000:8000 -p 9000:9000 \`.
  - Change the sentence after the block to: "The camera API is on 8443 (HTTPS) and 8080 (HTTP), the control API on 9443, RTSP on 8554, ONVIF on 8000 and [Baichuan](#baichuan-port-9000) on 9000."
- **Configuration table:** after the `CAMSIM_ONVIF_PORT` row, add:

```markdown
| `CAMSIM_BAICHUAN_PORT` | `9000` | [Baichuan](#baichuan-port-9000), the camera's own protocol (login and recordings download). In process (`createCamSim`), a free port unless `listen()` names one |
```

- **Ports and services table:** after the ONVIF row, add:

```markdown
| Baichuan | 9000 | 9000 (`mediaPort`) | login and recordings download, see [Baichuan](#baichuan-port-9000) |
```

- **Recordings: Download:** at the end of the section, add the paragraph: "With `downloads.refuse` on (the real camera's state since 2026-10-01), the same files still download over [Baichuan](#baichuan-port-9000)."
- **New section** directly after "Recordings: Download" (before `### RTSP`):

````markdown
### Baichuan (port 9000)

The camera's own binary protocol, which the Reolink app uses. cam-sim answers
the part cam-proxy needs: logging in and downloading a recording. On the real
camera HTTP `Download` has been refused since 2026-10-01, while Baichuan
downloads of the same files work; `downloads.refuse` and this port together
reproduce that.

- **Framing and ciphers**, as measured on the RLC-1224A
  ([reference/rlc-1224a/baichuan/](reference/rlc-1224a/baichuan/README.md)):
  - Every message starts with the magic `f0 de bc 0a`.
  - The client sends class `14 65` (the nonce request, a 20-byte header) and
    `14 64` (everything else).
  - Every reply and push is class `00 00` with a 24-byte header, except the
    nonce reply (`14 66`, 20 bytes).
  - Replies echo the message id and the channel byte.
  - The nonce reply, the login and the login reply are XOR-encoded;
    everything after the login is AES-128-CFB.
  - Download chunks encrypt only their first 1024 bytes.
- **Login** (cmd 1) sends `md5_31(user + nonce)` and
  `md5_31(password + nonce)`, checked against `CAMSIM_USERS`, admin and guest
  alike:
  - success answers 200 with `DeviceInfo`;
  - wrong credentials answer 401 with `<remainTimes>10</remainTimes>`, and
    the connection stays open.
- **Commands after the login:**

| cmd | Answer |
|---|---|
| 8, download: `<Id>` is the full name HTTP Search returns; `<name>` is optional and ignored | 200 with a 32-byte info record, then the file in chunks (39,400 B three times, then 12,872 B, repeating). Every frame carries cmd 8's message id; there is no terminator. An unknown `<Id>` answers 400 with no body |
| 9, stop (`handle` 0) | 200, no body. 13 more chunks of the running download still arrive, then nothing |
| 13, file info | 200 with `sizeL`/`sizeH`. With `<name>` it reports the main file's size even for a sub `<Id>`, as the camera does. A file it doesn't know answers 431 without `<name>` and 400 with it |
| 93, LinkType | 200, `<LinkType><type>LAN</type>` |
| 2, logout | 200, then the connection closes |
| anything else | 405, no body; the session stays usable |

- **Sessions:**
  - There is one session per TCP connection, and a close ends it at once.
  - HTTP `GetOnline` lists open sessions (user and address), numbered from
    the same counter as HTTP sessions.
  - A request before the login, or bad magic, closes the connection without
    a reply.
- **Limits:**
  - 12 connections at once, counting those that never logged in. The 13th
    is accepted, then reset at its first message.
  - A logged-in connection closes 32 s after the client's last message; one
    that never sends closes after 12.5 s.
- **Pushes:** after a login, cmds 78, 79, 464, 547, 291, 677, 600 and 669
  arrive unsolicited (message id 0), 0.04–0.5 s later. If a request comes
  first, they arrive between it and its reply.
- **Downloads:**
  - One download per connection: a second cmd 8 silently replaces the first.
  - Separate connections download in parallel, independently of HTTP
    Download and its one-at-a-time limit.
- **Faults** are the `baichuan.*` faults (see [Faults](#faults)):
  - `offline`, `power-off` and `reboot` drop Baichuan connections and refuse
    new ones;
  - `downloads.dropActive` cuts Baichuan transfers too.
````

- **What differs from the real camera:** before the bullet `- **Not measured on the real camera, so chosen:**`, add:

```markdown
- **Baichuan (port 9000):** only login, download, stop, file info, LinkType
  and logout. Search (14/15/16), live video, events and settings answer 405,
  where the camera answers them. The post-login pushes come once (the camera
  sometimes repeats them about 32 s later). Not measured, so chosen:
  - a guest user logs in like an admin (the camera's `proxy` user is admin level);
  - Baichuan transfers don't share HTTP Download's one-at-a-time limit (HTTP
    Download is refused on the camera, so that can't be measured);
  - a running download keeps its connection from the idle close;
  - a refused cmd 8 leaves a running download alone;
  - the 13 chunks after cmd 9 all come after its reply;
  - certificate restarts don't touch port 9000;
  - a declared message body over 1 MiB closes the connection;
  - the nonce is 29 hexadecimal characters (the traced length; the alphabet was redacted);
  - the info record reports `GetEnc`'s sizes, even for the test pattern's 1280×720 main stream.
```

- **State:** in the JSON block, change the counters lines to:

```json
  "counters": { "logins": 1, "loginAttempts": 1, "activeSessions": 1, "devInfoCalls": 0,
                "activeStreams": 0, "streamsOpened": 0, "downloads": 0, "activeDownloads": 0,
                "droppedDownloads": 0, "downloadOrder": [], "searches": 0, "setCalls": [], "reboots": 0,
                "ftpUploads": 0, "ftpFailures": 0, "ftpDropped": 0,
                "baichuanSessions": 0, "baichuanLogins": 0, "baichuanDownloads": 0, "droppedBaichuanDownloads": 0 },
```

  and add the bullet "`activeSessions` counts HTTP sessions; `baichuanSessions` counts the open, logged-in Baichuan connections (both show in `GetOnline`)."
- **Power and one-shot actions:** change the `downloads.dropActive` row's effect to "downloads in flight are cut, HTTP and Baichuan (their connections close)". Also add to the `reboot` and `power-off` effects: "Baichuan connections drop too".
- **Faults table:** change the `offline` row to "every camera connection is destroyed, Baichuan included (the camera stays powered)". After the `rtsp.reset` row, add:

```markdown
| `baichuan.refuse` | `count` optional | Baichuan cmd 8 answers 400 with no body and no chunks (like a missing file) |
| `baichuan.dropMidway` | | the Baichuan connection closes halfway through a download |
| `baichuan.delayMs` | `ms` | wait this long before each Baichuan chunk (a slow transfer) |
| `baichuan.loginFail` | `count` optional | Baichuan logins answer 401 with `remainTimes` 10 |
| `baichuan.sessionLimit` | `max` | at most `max` Baichuan connections at once instead of 12; one more is accepted, then reset at its first message |
```

  and after the fault examples block, add the sentence: "`downloads.refuse` stays the HTTP fault: with it on, HTTP Download resets while Baichuan downloads work, as on the real camera since 2026-10-01."
- **Reset, request log, live feed:** in the `GET /sim/api/requests` bullet, add the sentence: "Baichuan messages show as port `baichuan`, method `BC`, the cmd number, the status and the body lengths (`len`, `replyLen`), never a body."

- [ ] **Step 6: Update `llms.txt` and `CHANGELOG.md`**

`llms.txt`:
- In the "Two APIs" bullet, change `with RTSP 8554 and ONVIF 8000.` to `with RTSP 8554, ONVIF 8000 and Baichuan 9000.`.
- After the SD pipeline bullet, add:

```markdown
- **Baichuan (TCP 9000):** the camera's own protocol, for login and recordings download (cmd 8, byte-equal to HTTP `Download`), as measured on the real camera (`reference/rlc-1224a/baichuan/`). With the `downloads.refuse` fault it reproduces the real camera since 2026-10-01: HTTP Download refused, Baichuan works. Faults `baichuan.*`.
```

`CHANGELOG.md`, under `## Unreleased`:

```markdown
- Baichuan server on the camera's TCP port 9000 (`CAMSIM_BAICHUAN_PORT`), as measured on the RLC-1224A (`reference/rlc-1224a/baichuan/`):
  - Commands: login (cmd 1); download (8, the file byte-equal to HTTP `Download`); stop (9); file info (13); LinkType (93); logout (2).
  - Sessions show in `GetOnline`; the 12-connection limit, the 32 s idle close and the post-login pushes work as on the camera.
  - New faults `baichuan.refuse`, `baichuan.dropMidway`, `baichuan.delayMs`, `baichuan.loginFail` and `baichuan.sessionLimit` (`max`). `offline`, `power-off`, `reboot` and `downloads.dropActive` also act on port 9000.
  - New state counters `baichuanSessions`, `baichuanLogins`, `baichuanDownloads` and `droppedBaichuanDownloads`.
  - The image exposes 9000.
  - `createCamSim().listen()` also opens a Baichuan port (a free one unless `baichuan` is named) and returns it; `CamSimOptions.baichuan` shortens the idle timeouts for tests.
  - The reolink_aio MIT notice is in `THIRD_PARTY_NOTICES`.
```

- [ ] **Step 7: Run every check**

Run: `npx vitest run && npm run lint:types && npm run build && npm run check && npm run test:e2e`
Expected: all PASS. `test/openapi.test.ts` still matches, because no route changed.

- [ ] **Step 8: Commit**

```bash
git add openapi.yaml web/src/pages/Simulator.svelte web/src/lib/state.ts e2e/settings-simulator.spec.ts README.md llms.txt CHANGELOG.md
git commit -m "docs(baichuan): README, openapi, llms.txt, CHANGELOG; Simulator page faults"
```

---

### Task 9: PR, review, and the cam-sim release

**Files:** none (git and GitHub only).

**Interfaces:**
- Consumes: the branch `feat/baichuan-server` with Tasks 1–8.
- Produces: a release tag `vYYYY.MM.DD.N` that cam-proxy and cams then bump to.

- [ ] **Step 1: Final local checks**

```bash
npx vitest run && npm run lint:types && npm run build && npm run check && npm run test:e2e && scripts/container-smoke.sh
git status --short   # nothing unstaged or untracked
git log --oneline main..HEAD
```

Expected: everything passes, `smoke: OK`, the tree is clean, and there are 8 commits.

- [ ] **Step 2: Open the PR to `main`**

Write the body to `.superpowers/pr-body.md` (gitignored scratch). Cover:
- what was added (port 9000, the commands, the faults, the counters);
- the Review Focus items and where each is pinned;
- that it mirrors `reference/rlc-1224a/baichuan/`;
- the README's new "What differs" entries.

End the body with your session's PR attribution lines.

```bash
git push -u origin feat/baichuan-server
gh pr create --base main --head feat/baichuan-server --title "Baichuan server on port 9000 (login and recordings download)" --body-file .superpowers/pr-body.md
```

- [ ] **Step 3: Merge when every check passes**

`main` is not protected on cam-sim, so check it yourself. The check list must be non-empty and every check must pass:

```bash
PR=$(gh pr view feat/baichuan-server --json number -q .number)
gh pr checks "$PR" --watch || true
gh pr checks "$PR" --json name,state --jq 'length > 0 and all(.[]; .state == "SUCCESS" or .state == "SKIPPED")'
```

Expected: `true`. Only then:

```bash
gh pr merge "$PR" --merge --delete-branch
git checkout main && git pull
```

- [ ] **Step 4: Release (`main` → `production`)**

End the body with your session's PR attribution lines.

```bash
gh pr create --base production --head main --title "Release: Baichuan server (port 9000)" --body "Releases the Baichuan server (CHANGELOG, Unreleased)."
REL=$(gh pr list --base production --head main --json number -q '.[0].number')
gh pr checks "$REL" --watch || true
gh pr checks "$REL" --json name,state --jq 'length > 0 and all(.[]; .state == "SUCCESS" or .state == "SKIPPED")'
gh pr merge "$REL" --merge
```

Expected: `true` before the merge.

- [ ] **Step 5: Watch the release and confirm the tag**

```bash
RUN=$(gh run list --workflow release.yml --branch production --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" --exit-status
gh release view --json tagName,assets -q '.tagName, (.assets[].name)'
git checkout main && git pull   # the release commits "clear Unreleased" to main; branch after it
```

Expected:
- The run succeeds: image built, kube-setup digest pinned, cam2 deployed, `/healthz` checked, tag created.
- The release shows `vYYYY.MM.DD.N` and the npm tarball.

- [ ] **Step 6: Hand-offs (outside this repo)**

- **cam-proxy and cams** bump their cam-sim tarball to the new tag, in a PR each, from their own sessions:
  - cams-compat in this repo runs cams' suites against the build;
  - nothing does that for cam-proxy, so its PR runs its suite on the new tarball;
  - cam-proxy's Baichuan client plan uses this release for its integration tests.
- **kube-setup:** the Service-port request below.

---

## After the plan (not tasks here)

- **Request to the kube-setup session:**
  - Add a cluster-internal port to Service `cam2` (namespace `cam-sim`): `name: baichuan`, `port: 9000`, `targetPort: 9000`, TCP. Add the matching container port in the Deployment if the manifests list them.
  - The purpose: cam-proxy's cluster instance reaches cam2's Baichuan server.
  - No exposure outside the cluster: no ingress, LoadBalancer or NodePort. `cam2-gateway` (the LAN Service for ONVIF/RTSP) stays as it is.
  - If a NetworkPolicy limits cam2's traffic, include letting cam-proxy (namespace `cam-proxy`) reach port 9000.
  - Don't edit kube-setup from this repo.
- **The Pi is unchanged:** it runs cam-proxy against the real camera.
- **The real camera is not touched by this plan.**
