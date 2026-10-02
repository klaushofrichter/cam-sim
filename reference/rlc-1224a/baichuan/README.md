# Baichuan capture (RLC-1224A, 2026-10-02)

Phase 0 of the Baichuan recordings work: measurements on the real camera (cam1,
RLC-1224A, firmware v3.2.0.6011), TCP port 9000. They settle the open points of
cam-proxy's `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`
and of this repo's `docs/superpowers/specs/2026-10-02-baichuan-server-design.md`.

The client was a small raw-socket script (framing and ciphers as in
reolink_aio, MIT), so every header byte is the camera's own. Each file is one
scenario: one line per message with the time, direction, raw header bytes and
decoded fields, then the decrypted XML.

## Files

| File | Scenario |
|---|---|
| `login-admin.txt`, `login-proxy.txt` | nonce exchange, login, logout; the full login reply XML |
| `vod-sub.txt`, `vod-main.txt` | search 14/15/16, then download 8, then stop 9 |
| `vod-nosearch.txt` | cmd 8 without a search: `<Id>` only, `<Id>` + `<name>`, main, and 13 → 8 → 9 |
| `fileinfo.txt` | cmd 13 variants (with and without `<name>`, sub and main) |
| `err-notfound.txt` | cmd 13 and cmd 8 for files that don't exist |
| `err-protocol.txt` | a request before login, bad magic, an unknown command |
| `err-badpass.txt` | one wrong password, then a correct login |
| `err-second-download.txt` | a second cmd 8 on the same connection; on a second connection; two in parallel |
| `session-limit.txt` | 32 closes without logout; concurrent sessions until refused; recovery; bare TCP connections |
| `idle.txt` | the idle timeout, the keep-alive, and the XML of the unsolicited pushes |
| `abort.txt` | aborting midway three ways, then the next download; HTTP Download before and after |

## Redacted

- The camera's address is `<camera>`. Other LAN hosts are `<pi>`, `<cluster>`
  and `<this host>`.
- The nonce, the hashed user name and password in the login, the password in
  the logout (`REDACTED`, `REDACTED-USER-HASH`, `REDACTED-NONCE`), and
  `secretCode`/`bootSecret` in the login reply. The AES key is never written.
- **No media bytes.** Chunk payloads are given as lengths only. The one
  payload in hex is the 32-byte info record that comes before the file data
  (see below); it is not file content.
- In the files other than `login-*.txt` and `idle.txt`, repeated login XML and
  push XML are replaced by a one-line placeholder.

## Wire format (as measured)

- **Header.** Magic `f0 de bc 0a`, cmd (u32 LE), body length (u32), channel
  byte (250 = host; 0 on pushes), message id (u24), status or encryption
  (u16), class (2 bytes), payload offset (u32, 24-byte headers only).
- **Classes.**
  - Client: `14 65` for the nonce request (20 bytes, `12 dc` offer) and
    `14 64` for everything else (24 bytes).
  - Camera: `14 66` for the nonce reply (20 bytes, `12 dd`), and **`00 00`
    with a 24-byte header for every other reply and push**.
- **Encryption.**
  - The nonce reply and the login reply are BC-XOR encoded (offset 250).
  - Everything after a successful login is AES-128-CFB with a fresh IV per
    part: replies, extensions and pushes.
  - Download chunks have `encryptLen` 1024: only the first 1024 bytes are AES.
- **Nonce reply.** `<Encryption version="1.1"><type>md5</type><nonce>…</nonce>`,
  plus an `<authTypeList>` with `password`, `sigV1`, `authLogin` and
  `getAccesskey`.
- **Login reply.** Status 200, about 5 KB: `DeviceInfo` and `StreamInfoList`.
- **Pushes.** The camera sends unsolicited messages to every logged-in
  session, with message id 0, channel 0 and status 200:
  - cmds 78 (`VideoInput`), 79 (`Serial`), 464 (`NetInfo`), 547 (`SirenStatusList`),
    291 (`FloodlightStatusList`), 677 (`ioStatus`), 600 (`yoloWorldEventList`)
    and 669 (`AiModelList`);
  - timing (idle.txt): 78 and 79 about 0.30 s after the login reply, 464 and 547
    about 0.40 s after it; 291, 677, 600 and 669 once, at about 32.5 s as an idle
    session is closed, or, when the client sends something at 20 s (cmd 93 or an
    unknown cmd), within milliseconds of that message. A second 78/79/464/547
    round about 1 s after login shows up in one trace, with two sessions
    interleaved, so it is not established;
  - they can arrive between a request and its reply. A client must match
    replies by cmd **and** message id, and ignore the rest.
- **Replies echo the request's message id** (and channel 250). That includes
  every cmd-8 chunk (below).
- **Logout** (cmd 2): 200, no body, then the camera closes the TCP connection.

### Download (cmd 8)

1. The first reply: status 200, extension `<binaryData>1</binaryData>`
   (106 B), and a 32-byte payload. This is an info record, not file data:
   - `"1002"`, then u32 32, u32 width, u32 height;
   - a zero byte, then the fps;
   - start and end as y−1900, month, day, hour, minute, second;
   - a flag byte (0 for sub, 1 for main), then a zero byte.

   Sub: `31 30 30 32 20 00 00 00 80 03 00 00 00 02 00 00 00 0a 7e 0a 02 04 07 3a 7e 0a 02 04 08 13 00 00`.
   Main: the same with `a0 11 00 00 d0 09 00 00 00 14` (4512×2512, fps 20)
   and the flag `01`.
2. **Chunks**: the extension `<binaryData>1</binaryData><encryptLen>1024</encryptLen>`
   (136 B). Payload sizes repeat 39,400, 39,400, 39,400, 12,872 (= one
   128 KiB block), and the last chunk is shorter.
3. Every chunk echoes **cmd 8's message id**.
4. **No terminator.** After the last byte nothing more comes, even 3 s later
   without cmd 9. The end is the size.
5. cmd 9 (`handle` 0) answers 200 with no body.
6. The bytes are identical whichever way the download is started (search
   first or not, with or without `<name>`): the same MD5, starting with
   `ftyp`, and as long as the size.

### Throughput

Measured on the LAN.

| | Size | Time (cmd 8 to the last byte) | Rate |
|---|---|---|---|
| sub | 458–468 KB | 0.05–0.08 s | 6–9 MB/s (latency-bound) |
| main | 6.2–6.7 MB | 0.60–0.62 s | 10.8–10.9 MB/s |
| two mains in parallel (two connections) | 6.2 + 6.7 MB | 1.1 s | 5.7 + 5.9 MB/s |

The first chunk arrives 9–39 ms after cmd 8.

## Answers to the phase-0 points

| Point (spec default) | Measured |
|---|---|
| Are 14/15/16 needed before 13/8? (no) | **No.** cmd 8 with `<Id>` alone works, and its bytes equal those of the search path. `<name>` is optional for cmd 8. |
| Does cmd 13 work without a search, and which handle does cmd 9 take? (yes; cmd 13's handle) | It answers, but **with `<name>` it looks the file up by start time and reports the main file's size for a sub `<Id>`** (6,716,462 for a 467,534 B sub file). Without `<name>` it reports the right size. Its `handle` is always 0. cmd 9 takes `handle` 0 on every path. **Recommendation:** skip cmd 13 and take the size from the file name. |
| Can the `proxy` user log in? (yes) | **Yes** (200). On this camera `proxy` has level `admin` (`GetUser`), so a true guest-level user is still unmeasured. |
| Plain close or logout? (plain close) | **Plain close is fine.** The session leaves HTTP `GetOnline` within 0.3 s. 32 closes in a row left nothing behind. A logout answers 200, then the camera closes the connection. |
| The session limit (one connection from the proxy) | **12 TCP connections on port 9000**, counting bare connections that never logged in. The 13th is accepted, then **reset at its first message, with no reply**. It recovers at once when one closes. HTTP logins are not affected. **Baichuan sessions are listed in HTTP `GetOnline`** (user name and client IP) while open. |
| The idle timeout (over 60 s) | **About 32 s after the client's last message** for a logged-in session; **about 12.5 s** for a TCP connection that never sends. Any request resets it: cmd 93 (`LinkType`, which answers 200 `<LinkType><type>LAN</type>`), or even an unknown cmd answered 405. **A running transfer keeps the session alive:** a 9 MB main file read at ~115 KB/s arrived complete after 77.6 s with no client message (2026-10-02, cam-proxy's own client). **The default is wrong:** use one connection per job, or send cmd 93 at most every 20 s. |
| A second download while one runs (refused) | **Not refused.** On the **same connection**, a new cmd 8 **silently replaces** the running one: the old one stops with no message, and the new one arrives complete under its own message id. On a **second connection**, both run in parallel and both complete. The proxy's one-at-a-time rule is our choice, not the camera's. |
| Abort midway, then the next download (works after cmd 9 and a drain) | **Works.** After cmd 9, about 400 KB (13 frames) still in flight arrive with the **old message id**, around and after the cmd-9 reply (200). Then nothing more comes. The next cmd 8 on the same connection works, even **without a drain** if the stale chunks are dropped by message id. A **socket close mid-transfer** is fine too: a new connection 0.5 s later downloads normally. **No power cycle was needed.** HTTP `cmd=Download` was refused before and after (connection dropped after 0.2 s): unchanged. |
| Do chunks echo cmd 8's message id? (by cmd and id) | **Yes.** Every cmd-8 frame, including the first info frame, carries the request's message id. |
| A nonexistent name and a wrong password (400; 401) | **Nonexistent:** cmd 8 → **400**, empty body, no chunks. cmd 13 → **400** with `<name>`, **431** without. **Wrong password:** **401** with a BC-encoded body `<LoginErrInfo version="1.1"><remainTimes>10</remainTimes></LoginErrInfo>`. The connection stays open, and a correct login 1 s later succeeds. (Tried once only.) |
| Do HTTP and Baichuan downloads share the one-transfer limit? (yes) | **Can't be measured:** HTTP Download is refused on this camera. Baichuan itself allows parallel transfers. |
| An unknown command | **405**, empty body; the session stays usable. |
| A request before login; bad magic | The camera **closes the connection** without a reply. |
| HTTP Search name = Baichuan `<Id>`; the name's last hex field = the size | **Yes, both.** The search's `<Id>` is exactly the HTTP Search `name`. For all 8 of today's files, the last hex field equals HTTP `size`. For the files searched and downloaded, it also equals the search's `sizeL` and the bytes received. |

## Consequences for the specs

- cam-proxy:
  - **13 is not needed:** cmd 8 → 9 with the size from the name, `<Id>` only.
  - **The idle close must stay under 30 s** (or use one connection per job).
  - Match chunks by cmd **and** message id, and drop pushes (message id 0).
- cam-sim:
  - Reply class `00 00`.
  - Pushes are optional to mirror.
  - Refuse the 13th connection by reset.
  - Idle close at about 32 s (12.5 s before any message).
  - A new cmd 8 replaces a running one.
  - Not found → 400; unknown cmd → 405; wrong password → 401 with `remainTimes`.
  - Sessions appear in `GetOnline`.
