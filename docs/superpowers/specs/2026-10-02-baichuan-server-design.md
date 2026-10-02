# Baichuan server for recordings (design)

Status: approved by Klaus in chat, section by section (2026-10-02). This spec
is for review.

The shared design (the protocol, the message flow, the cam-proxy API) is in
cam-proxy's spec, `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`
(cam-proxy repo), "Protocol summary". This spec covers only cam-sim's part.

## Goal

cam-sim answers Reolink's Baichuan protocol (TCP 9000) for login, file info
and download, the way the real RLC-1224A does, so that cam-proxy's new
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
  then cam-proxy's client, then cams.

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
- **Login**: the handshake from the cam-proxy spec. The nonce reply (XOR), then
  the login (XOR) checked against the sim's existing users (`CAMSIM_USERS`),
  admin and guest alike, so the `proxy` user works as on the real camera
  (if phase 0 shows the camera refuses non-admin users, the sim does too).
  A login checks every user by computing `md5_31(user + nonce)` and
  `md5_31(password + nonce)`. Wrong credentials: 401. Then AES for the rest of
  the connection.
- **Commands**: 13 (file info), 8 (download), 9 (stop), and 2 (logout,
  answered 200). 14/15/16 (search) only if phase 0 says they're needed. Any
  other command answers as phase 0's trace shows for an unknown command, or,
  if not captured, the connection ignores it.
- **Sessions**: one per TCP connection, ended by a close or cmd 2. They are
  separate from the HTTP login tokens (`src/engine/sessions.ts`) and not listed
  in `GetOnline`, unless phase 0 shows otherwise. The idle timeout and the
  session limit follow phase 0's measurements.

### Files

- The sim's existing recordings: the same files HTTP `Search` lists
  (`src/engine/sdcard.ts`, the media library's clip files).
- `<Id>` is the full path that HTTP `Search` returns as `name`, matched with
  `SdCard.byName()`. `<name>` (`01YYYYMMDDhhmmss`) must agree with it.
- Names, sizes and content agree: cmd 13's `sizeL`/`sizeH`, the size in the
  file name, HTTP Search's `size` and the bytes sent are the same number.
- **Download**: the first cmd-8 reply with `<binaryData>1</binaryData>` and the
  32-byte payload, then chunks with `<binaryData>1</binaryData><encryptLen>1024</encryptLen>`,
  the first `encryptLen` bytes AES-encrypted from a fresh IV. Chunk sizes as in
  the trace. No terminator: the sim stops after the last byte. It respects TCP
  backpressure (it waits for `drain`).
- **One VOD transfer at a time** across the device, sharing the existing
  `activeDownloads` rule with HTTP Download, unless phase 0 shows they are
  independent. A second cmd 8 while one runs answers as phase 0 measured.

### Mirroring

Reply XML, status codes and framing are copied from the traces in
`reference/rlc-1224a/baichuan/` (phase 0). Behaviour nobody measured isn't
invented: where phase 0 left a case unmeasured, the sim does the simplest
thing the traces allow, and the README's "What differs from the real camera"
says so.

### The traces (`reference/rlc-1224a/baichuan/`)

Phase 0 writes them; this repo keeps them as the reference. One file per
scenario (login, sub and main downloads with and without the search, and each
failure), plus a `README.md` like `reference/rlc-1224a/onvif/README.md`.

- Each message: direction, the header fields (cmd, class, message id, status,
  lengths), the extension XML and the decrypted body XML.
- Binary chunks: header fields and lengths only. **No media bytes**: no camera
  footage in the repo.
- **Redacted**: the camera's address (`192.0.2.10`), the nonce, the hashed user
  name and password in the login, the logout body, and anything key-like,
  each replaced by `REDACTED`. The README lists what was redacted.

### Faults

Through the control API (`src/engine/faults.ts`), like the existing ones.
They never touch the HTTP API.

| Fault | Field | Effect |
|---|---|---|
| `baichuan.refuse` | | cmd 8 is refused: the reply phase 0 measured (default: status 400, no chunks) |
| `baichuan.dropMidway` | | the connection closes halfway through a download |
| `baichuan.delayMs` | `ms` | wait this long before each chunk (a slow transfer) |
| `baichuan.loginFail` | `count` optional | logins answer 401 (the next `count`, or until cleared) |
| `baichuan.sessionLimit` | `max` | at most `max` Baichuan sessions at once; one more is refused the way phase 0 measured |

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

- Bad magic or a frame that doesn't parse: the connection closes (as phase 0
  shows for the camera, or this default).
- A cmd 8 or 13 for an unknown `<Id>`: the reply phase 0 measured for a
  nonexistent name (default: status 400, no chunks).
- A request before login: the connection closes, unless phase 0 shows a reply.
- A client that stops reading: the sim waits (backpressure); it never buffers
  a whole file.
- The server never logs a password, a nonce, a key or a body above debug
  level.

## Testing

- **Unit**: the frame codec, the ciphers (the same aio-oracle vectors as
  cam-proxy's, with a test password), name and size agreement for every seeded
  recording.
- **Server** (vitest, a minimal test client in `test/`):
  - login with an admin user and with `proxy`; a wrong password gives 401;
  - cmd 13 sizes; sub and main downloads byte-equal to the HTTP Download of
    the same file, with the 32-byte first payload and partial encryption;
  - cmd 9; logout; a plain close;
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

## Open points (phase 0 decides)

| Point | Default until measured |
|---|---|
| Are 14/15/16 needed? | No; the sim answers 13/8/9 only. |
| Can a non-admin user log in over Baichuan? | Yes. |
| The session limit and how an extra session is refused | Unknown; `baichuan.sessionLimit` closes the new connection without a reply. |
| The idle timeout | None; the sim keeps idle connections. |
| A second download while one runs | Refused like `baichuan.refuse`. |
| Abort midway, then the next download | Works after cmd 9. |
| Do HTTP and Baichuan downloads share the one-transfer limit? | Yes. |
| The reply shapes of a nonexistent name and a refusal | Status 400, no body. |

## References

- cam-proxy spec: `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`
  (cam-proxy repo): protocol, message flow, cipher constants, source links.
- cams spec: `docs/superpowers/specs/2026-10-02-recordings-via-proxy-design.md`
  (cams repo).
- Findings and trace: `~/Development/reolink/baichuan-download.md`,
  `~/Development/reolink/baichuan-vod-trace.txt`.
- reolink_aio `5d37cb3` and PR #186 `9a1bb52` (MIT).
- cams `docs/reolink-api.md`: HTTP Search and file names.
