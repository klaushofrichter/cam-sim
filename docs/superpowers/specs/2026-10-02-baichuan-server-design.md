# Baichuan server for recordings (design)

Status: approved by Klaus in chat, section by section (2026-10-02). This spec
is for review.

The shared design (the protocol, the message flow, the cam-proxy API) is in
cam-proxy's spec, `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`
(cam-proxy repo), "Protocol summary". This spec covers only cam-sim's part.

## Goal

cam-sim answers Reolink's Baichuan protocol (TCP 9000) for login and
download, the way the real RLC-1224A does, so that cam-proxy's new
Baichuan client can be tested against it. Klaus: "We may need to implement
the API that we use on the real camera also on the cam-sim."

## Background

- On 2026-10-01 the real camera started refusing every HTTP `cmd=Download`,
  while Baichuan downloads of the same files worked (sub 2.8 MB/s, main
  8.9 MB/s). Findings: `~/Development/reolink/baichuan-download.md`.
- cam-proxy will list recordings with HTTP `Search` and fetch them over
  Baichuan. cams will play them through cam-proxy.
- cam-sim already simulates the HTTP refusal: the `downloads.refuse` fault
  ("every Download resets"). It now needs the other half, a working Baichuan
  download, so a test can reproduce "HTTP refused, Baichuan works".
- Order of work: phase 0 (real-camera measurements, cam-proxy spec), then this,
  then cam-proxy's client, then cams. Phase 0 is done (PR #63); its answers
  are folded into this spec, and the traces are in
  `reference/rlc-1224a/baichuan/`.

## Design

### The server

- **Port**: `CAMSIM_BAICHUAN_PORT`, default 9000 (`0` picks a free port, for
  tests). It joins `ports` in `src/config.ts` and the "Ports and services"
  table in the README.
- **Code**: `src/baichuan/`: `frame.ts` (header codec and the streaming
  parser), `cipher.ts` (XOR, AES-128-CFB, partial chunk encryption),
  `server.ts` (connections, login, the VOD commands). Written fresh for
  cam-sim from the same MIT sources as cam-proxy's client (reolink_aio and its
  PR #186), with file headers saying so and their MIT notice in a new
  `THIRD_PARTY_NOTICES`. No code is shared with cam-proxy, so each side tests
  the other.
- **Framing** (as measured): the client sends class `14 65` (nonce request,
  20-byte header) and `14 64` (the rest, 24 bytes). Every reply and push is
  class `00 00` with a 24-byte header, except the nonce reply: `14 66`, 20
  bytes, bytes 16-17 `XX dd`. Replies echo the request's message id and
  channel byte.
- **Login**: the handshake from the cam-proxy spec. The nonce reply (XOR), then
  the login (XOR) checked against the sim's existing users (`CAMSIM_USERS`),
  admin and guest alike, so the `proxy` user works as on the real camera
  (there it is admin level, by Klaus's decision; no non-admin user is
  planned, so the sim doesn't model one differently). A login checks every
  user by computing `md5_31(user + nonce)` and `md5_31(password + nonce)`.
  The 200 reply is BC-XOR encoded and carries `DeviceInfo`; everything after
  it is AES. **Wrong credentials: 401** with the XOR-encoded body
  `<LoginErrInfo version="1.1"><remainTimes>10</remainTimes></LoginErrInfo>`;
  the connection stays open and a correct login can follow. The sim sends
  `remainTimes` 10 always (no lockout).
- **Commands**: 8 (download), 9 (stop, `handle` 0, 200 and no body), 13 (file
  info, because the camera answers it and the sim copies the camera, though
  cam-proxy never sends it), 93 (`LinkType`: 200 with
  `<LinkType><type>LAN</type>`), and 2 (logout: 200, then the sim closes the
  connection). 14/15/16 (search) are not implemented, since cmd 8 with `<Id>`
  alone works. **Any other command answers 405** with no body, and the session
  stays usable. A request before login, or bad magic, closes the connection
  without a reply.
- **Sessions**: one per TCP connection, ended by a close or cmd 2. A plain
  close frees the session at once. Open Baichuan sessions **are listed in
  HTTP `GetOnline`** (user name and client IP), as on the real camera; they
  are otherwise separate from the HTTP login tokens
  (`src/engine/sessions.ts`).
- **Session limit: 12 connections on port 9000**, counting connections that
  never logged in. The 13th is accepted, then reset at its first message with
  no reply; it works again as soon as one closes. HTTP is unaffected.
  `baichuan.sessionLimit` changes the number.
- **Idle timeout**: a logged-in connection is closed after **32 s** without a
  message from the client; a connection that never sends is closed after
  **12.5 s**. Any message resets it (cmd 93, a download request, a message
  answered 405). Both timeouts are constants in `src/config.ts`, so tests can
  shorten them.
- **Pushes**: after login the sim sends unsolicited messages, class `00 00`,
  message id 0, channel 0, status 200: cmds 78, 79, 464, 547, 291, 677, 600
  and 669, 0.04 to 0.5 s after the login, with the bodies from the trace. They
  go to every logged-in session, and may arrive between a request and its
  reply (the sim interleaves them, so cam-proxy's parser is exercised). They
  are not repeated (the real camera's second batch about 32 s later is left
  out).

### Files

- The sim's existing recordings: the same files HTTP `Search` lists
  (`src/engine/sdcard.ts`, the media library's clip files).
- `<Id>` is the full path that HTTP `Search` returns as `name`, matched with
  `SdCard.byName()`. `<name>` (`01YYYYMMDDhhmmss`) is optional in cmd 8 and
  ignored there: the bytes are the same with or without it.
- Names, sizes and content agree: the last hex field of the file name, HTTP
  Search's `size` and the bytes sent are the same number. cmd 13 without
  `<name>` reports that size in `sizeL`/`sizeH`. With `<name>` it looks the
  file up by start time, as the camera does, and so reports the **main**
  file's size for a sub `<Id>`; `handle` is always 0.
- **Download**: the first cmd-8 reply with `<binaryData>1</binaryData>` and the
  32-byte info record (`"1002"`, the size, width, height, fps, start and end,
  a main/sub flag), then chunks with
  `<binaryData>1</binaryData><encryptLen>1024</encryptLen>`, the first
  `encryptLen` bytes AES-encrypted from a fresh IV. Chunk sizes as in the
  trace (39,400 B three times, then 12,872 B, repeating; the last is shorter).
  **Every frame echoes cmd 8's message id.** No terminator: the sim stops
  after the last byte. It respects TCP backpressure (it waits for `drain`).
- **Transfers**: one VOD transfer per connection. A second cmd 8 on the same
  connection **silently replaces** the running one (no message for the old
  one; the new one arrives complete under its own message id). Two
  connections run in parallel. Baichuan transfers are independent of HTTP
  Download and of `activeDownloads` (the real camera refuses HTTP Download, so
  a shared limit can't be measured).
- **Abort**: cmd 9 answers 200, and about 400 KB of chunks already in flight
  still arrive with the old message id, around and after the reply; then
  nothing. The sim mirrors that by sending the next 13 frames after cmd 9
  instead of stopping at once. The next cmd 8 on the connection works. A
  close mid-transfer is fine too.

### Mirroring

Reply XML, status codes and framing are copied from the traces in
`reference/rlc-1224a/baichuan/` (phase 0). Behaviour nobody measured isn't
invented: where phase 0 left a case unmeasured, the sim does the simplest
thing the traces allow, and the README's "What differs from the real camera"
says so.

### The traces (`reference/rlc-1224a/baichuan/`)

Phase 0 wrote them (cam-sim PR #63); this repo keeps them as the reference.
One file per scenario (login, sub and main downloads, the cmd-13 variants, each
failure, the session limit, idle, abort), plus a `README.md` like
`reference/rlc-1224a/onvif/README.md`.

- Each message: direction, the header fields (cmd, class, message id, status,
  lengths), the extension XML and the decrypted body XML.
- Binary chunks: header fields and lengths only. **No media bytes**: no camera
  footage in the repo.
- **Redacted**: the camera's address (`<camera>`, and `<pi>`, `<cluster>`,
  `<this host>` for other LAN hosts), the nonce, the hashed user
  name and password in the login, the logout body, and anything key-like,
  each replaced by `REDACTED` (or `REDACTED-USER-HASH`, `REDACTED-NONCE`). The
README lists what was redacted.

### Faults

Through the control API (`src/engine/faults.ts`), like the existing ones.
They never touch the HTTP API.

| Fault | Field | Effect |
|---|---|---|
| `baichuan.refuse` | | cmd 8 is refused: status 400, no body, no chunks (as for a nonexistent name) |
| `baichuan.dropMidway` | | the connection closes halfway through a download |
| `baichuan.delayMs` | `ms` | wait this long before each chunk (a slow transfer) |
| `baichuan.loginFail` | `count` optional | logins answer 401 with `remainTimes` 10 (the next `count`, or until cleared) |
| `baichuan.sessionLimit` | `max` | at most `max` Baichuan connections at once instead of 12; one more is accepted, then reset at its first message with no reply |

- `FaultSpec` gains `max` (a positive integer), used only by
  `baichuan.sessionLimit`.
- **HTTP Download refusal**: the existing `downloads.refuse` stays the HTTP
  fault and does not affect Baichuan. Together they reproduce "HTTP refused,
  Baichuan works".
- Existing faults and actions extend to the new port, so the sim stays one
  device: `offline`, `power-off` and `reboot` drop Baichuan connections and
  refuse new ones; `downloads.dropActive` also cuts Baichuan transfers;
  `clear` clears the new faults.
- As `CLAUDE.md` requires, the README fault table, the Simulator page labels
  and the CHANGELOG change together.

### State and logs

- The control API's state gains counters: `baichuanSessions` (open now),
  `baichuanLogins`, `baichuanDownloads`, `droppedBaichuanDownloads`.
- The request log records each Baichuan message's cmd, status and lengths,
  never a body or a credential.

### Deployment

- The container exposes 9000 (`Dockerfile` `EXPOSE`; `compose.yaml` maps it to
  `127.0.0.1` like the other ports).
- **cam2 in the cluster** needs a cluster-internal Service port 9000
  (`baichuan`, TCP) so cam-proxy's cluster instance can reach it. This is a
  request to the kube-setup session, with no exposure outside the cluster: no
  ingress, LoadBalancer or NodePort. If a NetworkPolicy limits cam2's traffic,
  the request includes letting cam-proxy reach 9000.
- The Pi is unchanged (it runs cam-proxy against the real camera).

### Docs and release

- README: a "Baichuan" section under "Simulated camera API" (the port, what is
  answered, what differs), the fault table, the ports table, the state
  counters. `openapi.yaml` for the control API's fault and state changes.
- A cam-sim release; then cam-proxy and cams bump their cam-sim tarball
  (`CLAUDE.md`: cams-compat runs cams' suites; nothing does that for cam-proxy).

## Error handling

- Bad magic or a frame that doesn't parse: the connection closes without a
  reply.
- A cmd 8 for an unknown `<Id>`: status 400, no body, no chunks. cmd 13: 400
  with `<name>`, 431 without.
- An unknown command: 405, no body; the session stays usable.
- A request before login: the connection closes without a reply.
- A client that stops reading: the sim waits (backpressure); it never buffers
  a whole file.
- The server never logs a password, a nonce, a key or a body above debug
  level.

## Testing

- **Unit**: the frame codec, the ciphers (the same aio-oracle vectors as
  cam-proxy's, with a test password), name and size agreement for every seeded
  recording.
- **Server** (vitest, a minimal test client in `test/`):
  - login with an admin user and with `proxy`; a wrong password gives 401
    with `remainTimes` and the connection stays open;
  - cmd 13 sizes, with and without `<name>` (the sub-file quirk); sub and main downloads byte-equal to the HTTP Download of
    the same file, with the 32-byte first payload and partial encryption;
  - cmd 9, with the stale chunks (old message id) after it, then a second
    download on the same connection; logout; a plain close, and the session
    gone from `GetOnline`;
  - a second cmd 8 on one connection replaces the first; two connections run
    in parallel;
  - pushes (message id 0) arrive between a request and its reply;
  - the 13th connection is reset at its first message; a close frees a slot;
  - the 32 s and 12.5 s idle closes (shortened through the config), and cmd 93
    resetting the idle timer;
  - unknown cmd: 405; a request before login and bad magic: the connection
    closes;
  - every fault, and `offline`, `power-off`, `reboot`,
    `downloads.dropActive` on the new port;
  - `downloads.refuse` on: HTTP Download resets, Baichuan still works;
  - backpressure: a slow reader doesn't grow the sim's memory.
- **Against the traces**: the reply XML of each traced scenario matches the
  reference file (redacted fields aside).
- `scripts/container-smoke.sh`: port 9000 answers a login.
- cam-proxy's integration tests are the second check (its spec).

## Out of scope

- Live video, events, settings or anything else over Baichuan.
- Gap-filling (#74 in cam-proxy) and cams' switch-over: other specs.
- Exposing 9000 outside the cluster.

## References

- cam-proxy spec: `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`
  (cam-proxy repo): protocol, message flow, cipher constants, source links.
- cams spec: `docs/superpowers/specs/2026-10-02-recordings-via-proxy-design.md`
  (cams repo).
- Findings and trace: `~/Development/reolink/baichuan-download.md`,
  `~/Development/reolink/baichuan-vod-trace.txt`.
- reolink_aio `5d37cb3` and PR #186 `9a1bb52` (MIT).
- cams `docs/reolink-api.md`: HTTP Search and file names.
