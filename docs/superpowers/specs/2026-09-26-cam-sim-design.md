# cam-sim: a Reolink camera simulator

Status: draft for review, 2026-09-26.

## 1. Purpose

cam-sim is a container that behaves like a Reolink **RLC-1224A** (firmware
v3.2.0.6011_2607012059) closely enough that software written against the real
camera cannot tell the difference, except where a test deliberately makes it.

It exists for:

1. **Pipeline testing.** CI starts one or more cam-sim containers next to the
   software under test (cams now, the camera gateway later) and drives them
   through a control API: pick the video, trigger events, inject faults, read
   counters.
2. **Multi-camera testing.** Several simulated cameras, including a permanent
   `cam2.skylar.technology` in the cluster, so cams has real cameras to choose
   between.
3. **Fault testing.** Every firmware quirk we know of is reproduced, and the
   failures we have seen can be switched on at will.

It **replaces the cams mock camera** (`cams/test/mock-camera/server.ts`) in
steps: first the e2e suite, then the unit tests (section 12).

### Minimum function

cam-sim must at least provide everything **cams uses today** and everything
the **camera gateway** (`~/Development/reolink/camera-gateway-design.md`) will
use. Anything beyond that is optional.

| Interface | cams | gateway | Phase |
|---|---|---|---|
| Login, tokens, the four rejection shapes | ✅ | ✅ | 1 |
| Device info, time, storage, `GetAbility`, `GetNetPort` | ✅ | ✅ | 1 |
| Settings Get/Set with whole-object semantics (Rec, MdAlarm, AiAlarm, Isp, IrLights, WhiteLed, Osd) | ✅ | ✅ | 1 |
| `Reboot` | ✅ | — | 1 |
| `Search` (one at a time) | ✅ | ✅ | 1 |
| `Download` | ✅ | — (replaced by FTP) | 1 |
| `Snap` | ✅ | occasional | 1 |
| HTTPS FLV live, sub and main (codec id 12) | ✅ | ✅ (HEVC viewers) | 1 fixture, 2 video |
| Event state polling `GetMdState` / `GetAiState` | — | ✅ (fallback) | 1 |
| Certificate import (the push CronJob) | — (cluster job) | — | 1 |
| RTSP sub and main | — | ✅ (go2rtc, frame grabber) | 5 |
| ONVIF events (PullPoint) on port 8000 | — | ✅ | 5 |
| FTP/FTPS clip upload | — | ✅ (clip intake) | 6 |
| Camera webhook (HTTP push) | — | if the real camera has it | only once confirmed on the real camera |
| Reolink "Baichuan" push on port 9000 | — | possible | only if the gateway chooses it (section 18) |

### Non-goals

- The Reolink cloud relay and the mobile app's use of port 9000. (Baichuan
  event push is an open question, section 18.)
- Copying Reolink's web UI code or look. The cam-sim UI is our own.
- Other Reolink models. The design keeps model-specific values in one profile
  so a second profile could be added later, but only the RLC-1224A is built.
- Image analysis. Events are triggered, not detected.

## 2. Principles

- **The firmware is the reference, not the documentation.** Behaviour comes
  from `cams/docs/reolink-api.md` and measurements of the real camera. When
  they disagree, the measurement wins, and the doc gets fixed.
- **Quirks are always on; faults are switched.** Things the real camera always
  does (section 7) cannot be turned off, so a test can't pass against a
  friendlier camera. Things that happen only sometimes (section 8) are faults.
- **The camera surface and the control surface never mix.** Nothing reachable
  through the camera API can change simulator state beyond what the real
  camera allows.
- **Headless first.** The container is fully useful with no browser: the web
  UI is optional and off by default.
- **No secrets in logs, URLs or images.** Tokens and passwords come from the
  environment or mounted files, and are never printed.

## 3. Architecture

One container is one camera. Several cameras means several containers.

```
                    ┌───────────────────────── cam-sim container ─────────────────────────┐
 cams / gateway ───▶│ Camera API (HTTPS + HTTP)   ──┐                                      │
                    │   JSON cmds, Snap, FLV,       │                                      │
                    │   Search, Download            ├──▶  Camera engine                    │
 VLC / gateway ────▶│ RTSP (MediaMTX), ONVIF      ──┤     identity, users, sessions,       │
                    │                               │     settings, SD card, events,       │
 CI / scripts ─────▶│ Control API (bearer token)  ──┤     faults, counters                 │
 browser ──────────▶│ Web UI (optional)           ──┘            │                         │
                    │                                            ▼                         │
                    │                                 Media pipeline (ffmpeg)              │
                    │                                   video library, live sources,       │
                    │                                   pre-record ring, clip writer       │
                    │                                            │                         │
 FTP server ◀───────│ FTP uploader (optional)  ◀─────────────────┘                         │
                    └──────────────────────────────────────────────────────────────────────┘
                                         /data volume: settings, SD card, certificate, library cache
```

- **Language and stack:** Node 24 + TypeScript + Express 5 (like cams). Svelte 5
  + Vite for the web UI. vitest and Playwright for tests. ffmpeg for all media
  work. MediaMTX, as a child process, for RTSP.
- **Camera engine:** pure TypeScript, no I/O of its own beyond the `/data`
  volume. Every surface calls into it. This is what the in-process test mode
  (section 12) exposes.
- **Media pipeline:** a set of supervised ffmpeg processes. In **fixture mode**
  (section 6.5) there is no ffmpeg at all.

## 4. Configuration

Everything is set by environment variables (`CAMSIM_*`). Secrets can also be
given as `*_FILE` pointing at a mounted file, which wins over the plain variable.

| Variable | Default | Meaning |
|---|---|---|
| `CAMSIM_NAME` | `Cam` | camera name (`GetDevInfo.name`, OSD, FTP file prefix) |
| `CAMSIM_USERS` / `_FILE` | — (required) | camera users, `name:level:password` separated by `;`, e.g. `admin:admin:…;cams:admin:…` |
| `CAMSIM_CONTROL_TOKEN` / `_FILE` | — | bearer token for the control API and web UI. **Without it the control surface is disabled**, never open |
| `CAMSIM_WEB_UI` | `false` | serve the web UI on the control port |
| `CAMSIM_MEDIA` | `video` | `video` (ffmpeg pipeline) or `fixture` (no ffmpeg, bundled bytes) |
| `CAMSIM_VIDEO` | first library entry | video that plays at start |
| `CAMSIM_LIBRARY_DIR` | `/videos` | extra source videos, mounted read-only |
| `CAMSIM_DATA_DIR` | `/data` | persistent state |
| `CAMSIM_TZ` | `America/Chicago` | camera time zone, drives `GetTime` and file names |
| `CAMSIM_SD_MB` | `4096` | simulated SD card size |
| `CAMSIM_SPEED` | `fast` | `fast` or `real`: `real` turns on the real camera's timings (section 7.3) |
| `CAMSIM_AUTO_EVENTS` | `off` | background events, e.g. `motion:6/h,person:1/h` |
| `CAMSIM_SEED_CLIPS` | `none` | `none` or `demo`: start with a set of past clips (section 6.4) |
| `CAMSIM_TLS_CERT_FILE` / `_KEY_FILE` | — | certificate to serve at start; otherwise the one stored by `ImportCertificate`; otherwise a factory-style self-signed one (`CN=CERTIFICATE`) |
| `CAMSIM_HTTPS_PORT` | `8443` | camera HTTPS (the Service maps 443) |
| `CAMSIM_HTTP_PORT` | `8080` | camera HTTP (maps 80) |
| `CAMSIM_RTSP_PORT` | `8554` | RTSP (maps 554) |
| `CAMSIM_ONVIF_PORT` | `8000` | ONVIF events (maps 8000) |
| `CAMSIM_CONTROL_PORT` | `9443` | control API + web UI; TLS with the same certificate when one is set |
| `CAMSIM_FTP_*` | — | FTP upload target, see section 11.3 |
| `CAMSIM_LOG_LEVEL` | `info` | pino log level |

The container runs as a non-root user, hence the high ports. `GetNetPort`
reports the real camera's ports (443, 80, 554, 1935, 8000), because that is
what a client of the real camera expects to read.

## 5. Camera API

Served on both the HTTPS and HTTP ports, like the camera with HTTP enabled.
Reolink request and reply shapes are copied exactly (arrays in, arrays out,
`code`/`rspCode`, `value` objects).

### 5.1 Commands

| Area | Commands |
|---|---|
| Session | `Login` (returns only `Token {name, leaseTime: 3600}`), `Logout`, `GetOnline` |
| Device | `GetDevInfo`, `GetTime`, `GetHddInfo`, `GetEnc`, `GetNetPort`, `SetNetPort`, `CheckFirmware` (no update), `Reboot`, `GetAbility` (the subset cams and `reolink_aio` read) |
| Users | `GetUser`, `AddUser`, `DelUser`, `ModifyUser` |
| Recording | `GetRecV20`, `SetRecV20`, `Search`, `Download` (GET), `CheckDownload`, `Snap` (GET) |
| Detection | `GetMdAlarm`, `SetMdAlarm`, `GetAiAlarm`, `SetAiAlarm`, `GetMdState`, `GetAiState` |
| Image and lights | `GetIsp`, `SetIsp`, `GetIrLights`, `SetIrLights`, `GetWhiteLed`, `SetWhiteLed`, `GetOsd`, `SetOsd` |
| Certificates | `GetCertificateInfo`, `CertificateClear`, `ImportCertificate` |
| FTP | `GetFtpV20`, `SetFtpV20`, `TestFtp`; `TestFtpV20` and `GetFtp` return `-9` as on the real firmware |
| Live | `GET /flv?port=1935&app=bcs&stream=channel0_<main|sub>.bcs&token=…` |

An unknown command answers the way the firmware does (`rspCode -9`).

### 5.2 Settings state

Settings live in `/data/settings.json` in the exact shapes of the Get replies
(the values measured on the real camera are the factory defaults). They
survive a container restart. The control API can reset them to factory.

`GetMdState` / `GetAiState` report `1` while an event of that type is active,
so pollers see events the way they do on the camera.

## 6. Media

### 6.1 Video library

- **Built in:** three short, freely licensed clips (a person walking, a car,
  an empty scene), small enough to keep the image under ~300 MB.
- **Mounted:** any video files in `CAMSIM_LIBRARY_DIR`. Den footage stays in
  this private mount, not in the public repo.
- **Preparation:** each source is converted once, cached under
  `/data/library/<id>/`:
  - `main.mp4`: H.265, 4512×2512, 20 fps, ~8 Mbit/s, AAC, keyframe every 2 s;
  - `sub.mp4`: H.264, 896×512, 10 fps, ~1 Mbit/s, AAC, keyframe every 2 s;
  - `poster.jpg`, and metadata (duration, source name, hash).
  Sources without audio get silent AAC. Preparation is resumable and runs one
  file at a time; a video is selectable once its cache is complete.
- `GET /sim/api/videos` lists entries and their preparation state.

### 6.2 Live sources

- For the selected video, ffmpeg loops `main.mp4` **by copying** (no
  re-encode) and loops `sub.mp4` **re-encoded with the OSD burned in**: the
  camera name and clock at the positions and on/off states from `GetOsd`.
  At 896×512 this is cheap.
- Both feed an internal fan-out: FLV viewers, RTSP (via MediaMTX), Snap, and
  the pre-record ring.
- Switching the video restarts the sources at the next keyframe. Open FLV
  connections continue on the new video without a disconnect.
- Day/night and rotation settings are **not** rendered into the picture
  (reported only). This keeps live encoding to the sub stream.

### 6.3 FLV like the firmware

- **sub:** standard FLV, H.264 (codec id 7) + AAC.
- **main:** H.265 in FLV with the **legacy codec id 12**, packaged like the
  camera (AVC-style packet layout with an HEVC decoder configuration record).
  ffmpeg can't produce this, so cam-sim includes its own FLV tag writer for
  main, fed with H.265 access units from ffmpeg. Verified by playing it with
  mpegts.js 1.8+ in a browser and by comparing tag headers with a capture of
  the real camera.
- The response is endless `video/x-flv`, like the camera.

### 6.4 Events and recordings

- **Pre-record ring:** the last `preRec` seconds of both streams are kept as
  2-second segments.
- **An event** has a type (`motion`, `person`, `vehicle`, `pet`) and a
  duration. It comes from the control API, the web UI or `CAMSIM_AUTO_EVENTS`.
  AI types also set motion, as on the camera. Events are recorded only if the
  `Rec` schedule allows that type at that hour, and `Rec.enable` is 1.
- **A recording** is written for each stream to the simulated SD card
  (`/data/sd/Mp4Record/YYYY-MM-DD/`), from the ring plus live, until
  `duration + postRec`. Overlapping events extend the recording and add
  trigger bits.
- **File names** follow the firmware exactly:
  `RecS0A_DST<date>_<start>_<end>_0_<flags>_<size>.mp4` (sub) and the main
  equivalent, with the DST marker, the trigger flag bits at positions 17, 19,
  20, 24, and the main copy ending a few seconds after the sub copy.
- While a recording is still being written, Search reports its end as
  `000000`.
- **Search** returns the firmware shapes (day list, `File` entries with
  `StartTime`/`EndTime` objects, `size`, `name`).
- **Download** remuxes the file on the fly to fragmented MP4 (`ftyp mp42`
  first), so the byte count differs from the Search `size`, as on the camera.
- **SD card:** `GetHddInfo` reports `capacity` (MB total) and `size` (**MB
  free**). When the card is full, the oldest day is deleted first. `saveDay`
  is honoured.
- **Seeding:** `CAMSIM_SEED_CLIPS=demo` or `POST /sim/api/recordings/seed`
  creates clips on past days (by copying library segments, no encoding), for
  example one clip per trigger type today and yesterday, like the cams mock's
  `DEFAULT_MOCK_CLIPS`. The seed request can list exact clips
  (`daysAgo`, `start`, `end`, `triggers`, `mainEnd`).

### 6.5 Fixture mode

`CAMSIM_MEDIA=fixture` needs no ffmpeg and starts in well under a second:

- Snap serves a bundled JPEG; FLV serves a bundled short FLV in a loop.
- Recordings are bundled tiny MP4s renamed to the firmware pattern.
- Events and seeding work, and produce the same names and Search results.
- RTSP and FTP are unavailable. `GetMdState`/`GetAiState` and ONVIF events
  work, since they need no media.

This is the mode for unit tests and fast CI jobs. The video mode is for
end-to-end and manual tests.

## 7. Always-on firmware behaviour

### 7.1 Sessions and tokens

- Tokens are valid for `leaseTime` 3600 s. Sessions that aren't logged out
  **accumulate** until their lease ends, and show in `GetOnline`.
- Changing a user's password, deleting a user, or rebooting invalidates that
  user's (or every) token.
- Password or `user=`/`password=` query auth on Download answers **404**.

### 7.2 The four rejection shapes

| Endpoint | Invalid or expired token |
|---|---|
| JSON commands | `code: 1`, `rspCode: -6` |
| `Snap` | HTTP 200, `text/html`, body is the `-6` JSON |
| `/flv` | connection reset, no HTTP response |
| `Download` | HTTP 401, `text/html`, empty body |

### 7.3 Other quirks

- A second `Search` overlapping one in progress gets `rspCode -54`.
- A percent-encoded Download `source` resets the connection.
  `cmd=download` (lowercase) works. `cmd=Playback` answers 404.
- One Download at a time: a second concurrent Download resets;
  `CheckDownload` reports `downloadTask`.
- `Download` depends on the HTTP service and `/flv` on RTMP: if `SetNetPort`
  turns either off, those endpoints fail with the real symptoms (connection
  drop), while the rest keeps working.
- **Partial Set resets omitted keys.** A Set with a partial object answers
  `code 0` and reads back fine immediately, but the omitted keys are reset
  in the saved state and take effect after the next reboot.
- Invalid values keep the old value: `SetMdAlarm sensDef` outside 1–50 gives
  `-56`; an unknown `dayNight` gives `-67`; `SetFtpV20` with `server: ""`
  gives `-4`.
- `sensDef` runs 1–50, lower is more sensitive.
- `Reboot` answers or drops the connection (randomly, 50/50, seeded for
  tests), goes offline, comes back with a **new serial**, and all tokens invalid.
- Importing a certificate over an existing one answers `200` and changes
  nothing; `CertificateClear` first.
- `CAMSIM_SPEED=real` adds the camera's timings: Downloads at ~150 KB/s,
  Search ~0.3 s, reboot ~60 s offline, Login ~0.2 s. `fast` keeps
  the behaviour but with short timings (reboot 1 s, no throttling).

## 8. Faults

Faults are switched through the control API or the web UI, never through the
camera API. Each is either **on** until turned off, or **for the next N**
matching requests. Several can be active at once.

| Fault | Effect |
|---|---|
| `downloads.refuse` | every Download resets (the state the real camera has been in since 2026-09-26) |
| `downloads.dropFirst` (N) | reset the next N Downloads |
| `downloads.dropMidway` | cut active Download bodies part-way |
| `downloads.delayMs` | wait before sending the body |
| `flv.reset` | reset every `/flv` connection, even with a valid token |
| `flv.dropActive` | end all open `/flv` connections now |
| `flv.delayMs` | delay the `/flv` response |
| `search.delayMs` | make Search slower (widens the `-54` window) |
| `settings.fail` (cmd list, rspCode) | chosen Set commands answer an error |
| `settings.ignore` (cmd list) | chosen Set commands answer 200 and change nothing |
| `tokens.revoke` | invalidate every session now |
| `reboot` (ms, dropsConnection) | reboot with chosen timing |
| `offline` | destroy every connection on every camera port |
| `latencyMs` | add delay to every camera request |
| `snap.fail` | Snap answers 500 |

These cover every option of the cams mock camera (`flvDelayMs`,
`downloadDelayMs`, `searchDelayMs`, `dropFirstDownloads`, `settingsFailures`,
`ignoreWrites`, `rebootMs`, `rebootDropsConnection`, `offline`,
`rejectAllStreams`, `revokeTokens()`, `dropStreams()`, `dropDownloads()`).

## 9. Control API

Base path `/sim/api` on the control port. Every request needs
`Authorization: Bearer <CAMSIM_CONTROL_TOKEN>`, compared in constant time.
JSON in and out. The token never goes in a URL.

| Method and path | Purpose |
|---|---|
| `GET /sim/api/state` | identity, selected video, active events, active faults, SD usage, and counters |
| `GET /sim/api/videos` | library entries and their preparation state |
| `PUT /sim/api/video` `{id}` | select the video |
| `POST /sim/api/events` `{type, durationS}` | trigger an event; returns the recording names it will produce |
| `GET /sim/api/events` | recent events |
| `POST /sim/api/recordings/seed` | create past clips (section 6.4) |
| `DELETE /sim/api/recordings` | empty the SD card |
| `GET /sim/api/faults`, `PUT /sim/api/faults/<name>`, `DELETE /sim/api/faults/<name>`, `DELETE /sim/api/faults` | faults |
| `POST /sim/api/reset` `{settings?, recordings?, counters?, faults?}` | return to a known state between tests |
| `GET /sim/api/requests?limit=` | recent camera API requests: command, status, duration (never tokens or passwords) |
| `GET /sim/api/stream` | SSE feed of state changes, events and requests, for the web UI and tests that wait on something |
| `GET /healthz` | unauthenticated liveness/readiness, no details |

**Counters** (replacing the mock's `/__state`): `logins`, `loginAttempts`,
`activeSessions`, `devInfoCalls`, `activeStreams`, `streamsOpened`,
`downloads`, `activeDownloads`, `droppedDownloads`, `downloadOrder`,
`searches`, `setCalls`, `reboots`, and the current settings objects.

An OpenAPI description is kept in the repo and checked by a test against the
routes.

## 10. Web UI

Off by default (`CAMSIM_WEB_UI=true` turns it on). Served on the control port.

- **Login:** the user pastes the control token once. The server answers with
  an HttpOnly, `SameSite=Strict`, signed session cookie; the UI never stores
  the token. Every UI write also sends a custom header, so a cross-site form
  can't forge it. No OAuth.
- **Camera pages** (similar in spirit to the camera's own UI): Live (sub and
  main), Playback (days, clips, download), and the settings cams uses
  (detection, recording schedule, image and lights, OSD, network ports,
  users, storage, reboot).
- **Simulator panel:** video picker with posters; buttons to trigger each
  event type with a duration; fault switches with their parameters; a live
  log of events and camera requests (from `/sim/api/stream`); reset buttons.
- The UI talks only to the control API, which calls the engine directly. It
  does not use the camera API, so it doesn't create camera sessions or
  change counters.

## 11. Gateway interfaces (later phases)

### 11.1 RTSP (phase 5)

MediaMTX, fed from the live sources, serves `rtsp://…:554/h264Preview_01_main`
and `h264Preview_01_sub` (the real camera's paths, including the misleading
`h264` in the main path), with the camera's user/password authentication.
Faults: `rtsp.reset`, `rtsp.refuse`.

### 11.2 ONVIF events (phase 5)

On the ONVIF port (8000; container 8000 → high port like the others), the
subset the gateway needs for events: `GetCapabilities`/`GetServices`,
`CreatePullPointSubscription`, `PullMessages`, `Renew`, `Unsubscribe`, with
WS-UsernameToken authentication. Event topics and message shapes (motion,
and the AI people/vehicle/dog_cat topics) are copied from a **capture of the
real camera** made before this phase is built; the spec does not guess them.
Media and PTZ services are out of scope.

### 11.3 FTP upload (phase 6)

Like the real camera, cam-sim is an FTP **client** only.

- Configured through `SetFtpV20` (or `CAMSIM_FTP_*` at start): server, port,
  user, password, `remoteDir`, `onlyFtps` (default FTPS, as on the camera;
  plain FTP when 0), `ftpSubStream`/`streamType`, schedule. `TestFtp` really
  connects. Partial writes reset keys, as for all settings.
- After each recording it uploads
  `<remoteDir>/YYYY/MM/DD/<Name>_00_YYYYMMDDHHMMSS.mp4` (main stream, or sub
  when selected; `moov` first) and a `.jpg`.
- Faults: `ftp.fail`, `ftp.delayMs`.

### 11.4 Webhook and Baichuan push

Not built until the real camera is shown to support a webhook, or the
gateway decides to use Baichuan push (section 18). The engine's event model
already carries everything either would need.

## 12. Replacing the cams mock camera

1. **cams e2e** switches to cam-sim containers in `video` or `fixture` mode:
   Den, Porch (`settings.fail SetWhiteLed`) and Shed (`downloads.refuse`), set
   up through the control API in Playwright's global setup instead of
   environment variables. The e2e tests that read `/__state` read
   `/sim/api/state` instead.
2. **cams unit tests** switch to the **in-process mode**: cam-sim exports
   `createCamSim(options)` from its package, which returns the Express apps
   and the engine in fixture mode, with no container. cams installs it as a
   git dependency pinned to a release tag (no npm publishing).
3. When both are done, `cams/test/mock-camera/` is deleted, and new quirks are
   added to cam-sim first.

## 13. Security and secrets

### 13.1 What exists

| Secret | Used by |
|---|---|
| `CAMSIM_CONTROL_TOKEN` | control API and web UI of the deployed simulators |
| camera user passwords (`CAMSIM_USERS`) | clients of the camera API, e.g. cams for cam2 |

For CI, workflows generate throwaway tokens and passwords per run; the
repository secrets are for jobs that talk to the deployed cam2.

### 13.2 `.env` and the sync script

- `~/Development/cam-sim/.env` (gitignored, mode 600) holds the real values
  for the cluster deployment. Klaus creates it; `.env.example` documents the
  keys with no values.
- `scripts/sync-secrets.sh`:
  1. Generates any missing value in `.env` (`CAMSIM_CONTROL_TOKEN`: 32 random
     bytes, base64url; passwords: 24 random characters), written in place,
     never printed.
  2. Sets the GitHub Actions secrets on `klaushofrichter/cam-sim` with
     `gh secret set`, value on stdin.
  3. Applies the Kubernetes Secret `cam-sim-secrets` (namespace `cam-sim`)
     with `kubectl create secret generic --from-env-file … --dry-run=client
     -o yaml | kubectl apply -f -`, against an explicit `--context`.
  4. Prints only the names it set, never values.
  - `--dry-run` shows what would change without writing anything. `--rotate
    <KEY>` replaces one value and syncs it.
  - Klaus runs it; it is not run by an agent.
- The cams side (cam2's `cams` user password in cams' `cams-cameras` Secret)
  is handled by cams' own script, `scripts/create-camera-user.sh`, pointed at
  cam2, as for cam1.

### 13.3 Other rules

- The control port and the camera ports are separate listeners.
- Logs contain command names and codes, never URLs with tokens, passwords, or
  the control token. A test asserts this.
- Request logs in `/sim/api/requests` redact tokens and passwords.
- The image contains no secrets and no Den footage.

## 14. Deployment

### 14.1 Local Docker

```sh
docker run --rm -p 8443:8443 -p 8080:8080 -p 9443:9443 \
  -e CAMSIM_USERS='admin:admin:…' -e CAMSIM_CONTROL_TOKEN=… \
  -v cam-sim-data:/data ghcr.io/klaushofrichter/cam-sim:latest
```

A `compose.yaml` in the repo runs three cameras (`cam2`, `cam3`, `cam4`) with
the web UI on, for local multi-camera work.

### 14.2 Image

- Multi-arch (`amd64`, `arm64`), so it runs on the Mac, in the cluster and on
  a Raspberry Pi.
- Base: Node 24 slim with ffmpeg and MediaMTX; non-root user; health check on
  `/healthz`.
- Published to `ghcr.io/klaushofrichter/cam-sim` with calendar versions
  (`vYYYY.MM.DD.N`), like cams.

### 14.3 Cluster (cam2)

kube-setup owns the manifests; this section is what cam-sim needs from them.

- Namespace `cam-sim`, one Deployment per camera (`cam2` first), one replica,
  a PVC for `/data`, and a read-only volume for the private video library.
- A Service exposing 443, 80, 554 and 8000 inside the cluster (plus 9443 for the
  control port). cams reaches cam2 at the Service address with TLS servername
  `cam2.skylar.technology`, the same way it reaches cam1 by IP.
- **DNS and certificate like cam1:** a Squarespace A record for
  `cam2.skylar.technology`, a cert-manager certificate via HTTP-01, and a
  daily push CronJob that uses `CertificateClear` + `ImportCertificate` on
  cam2, exactly as for cam1. This also exercises the push job against the
  simulator.
- **Not public:** as with cam1, the public name serves only the ACME
  challenge. The web UI is reachable from the LAN (for example through a
  LAN-only ingress or `kubectl port-forward`); deciding which is left to the
  cluster plan.
- Secrets from `cam-sim-secrets` (section 13.2).
- Resource guidance: one camera in video mode ≈ 1 CPU (sub re-encode) and
  512 MB RAM.

## 15. Repository

- `~/Development/cam-sim`, to become the public repo `klaushofrichter/cam-sim`
  (created when Plan 1 starts, after Klaus's go-ahead).
- Same conventions as cams: feature branch → PR to `main` → PR to
  `production` → release workflow; CodeQL gate with an accepted-exceptions
  file; CHANGELOG; docs in plain English.
- Layout:
  - `src/engine/`: camera engine (identity, users, sessions, settings, SD
    card, events, faults, counters);
  - `src/camera-api/`: Reolink-compatible HTTP surface;
  - `src/control-api/`: control API, SSE, health;
  - `src/media/`: library preparation, live sources, FLV writer, ring, clip
    writer, fixture media;
  - `src/rtsp/`, `src/onvif/`, `src/ftp/`: later phases;
  - `web/`: Svelte UI;
  - `test/`, `e2e/`: vitest and Playwright;
  - `scripts/sync-secrets.sh`, `compose.yaml`, `Dockerfile`, `openapi.yaml`.

## 16. Testing

cam-sim has **its own complete test suite**; it does not depend on cams or
the gateway to prove it works. Every interface in the minimum-function table
(section 1) is covered by cam-sim's own tests before it counts as done. The
cams suite (below) is an additional compatibility check, not a substitute.

- **Firmware conformance tests:** one test per row of sections 5 and 7, run
  against the in-process engine. The same suite can run against a real camera
  (read-only commands only, opt-in, credentials from the environment) to catch
  drift between cam-sim and the firmware.
- **Client-perspective tests:** for each interface, a test that uses it the
  way its consumer does: cams' request patterns (token renewal, retries after
  each rejection shape, whole-object writes), and the gateway's (RTSP pull
  with ffmpeg, ONVIF PullPoint loop, `GetMdState` polling, FTPS intake into a
  test FTP server).
- **Media tests:** FLV tag headers for main (codec id 12) and sub; recording
  names and trigger bits; Download starts with `ftyp mp42`; Search sizes.
- **Control API tests:** auth required, every fault, reset, SSE.
- **Container smoke test in CI:** start the image in fixture and video mode,
  log in, stream a few seconds of FLV, trigger an event, find it in Search,
  download it.
- **e2e:** web UI login, video switch, event trigger visible in Playback.
- **cams compatibility is the acceptance test.** cams' own test suites (unit
  and e2e) must pass with cam-sim in place of the mock camera:
  - the only change allowed on the cams side is how the camera is provided
    (containers or `createCamSim`, and state read from `/sim/api/state`); no
    cams assertion is weakened or deleted to make it pass;
  - a cam-sim CI job checks out cams at its latest `main`, swaps in the
    cam-sim build under test, and runs cams' suites. A cam-sim change that
    breaks cams fails cam-sim's CI;
  - where a cams test depends on a mock behaviour that the real firmware
    doesn't have, the test is fixed in cams (with a note), not copied into
    cam-sim.

## 17. Phases

Each phase ends with a release and something usable.

1. **Headless core:** engine, camera API (all of section 5 except FTP
   commands' real connection), always-on quirks, faults, control API, fixture
   mode, in-process mode, container image, sync script, CI. **Done when cams'
   unit and e2e suites pass against cam-sim** (section 16), and cams has
   switched over.
2. **Video:** library preparation, live sources with OSD, FLV writer
   (codec id 12), Snap from video, pre-record ring, real recordings, seeding
   from video, `CAMSIM_SPEED=real`.
3. **Web UI.**
4. **cam2 in the cluster:** image deployment (with kube-setup), certificate
   push, cams configured with cam2 as a second camera.
5. **Gateway streaming and events:** RTSP via MediaMTX, ONVIF PullPoint events.
6. **FTP/FTPS upload.**

Phases 5 and 6 can move ahead of 3 and 4 if gateway work starts first.

## 18. Open questions

- The web UI route in the cluster (LAN-only ingress or port-forward), decided
  in phase 4 with kube-setup.
- Which freely licensed clips to bundle, decided in phase 2.
- How the gateway receives events (webhook, ONVIF, Baichuan push or
  polling). cam-sim builds ONVIF and polling; webhook and Baichuan follow the
  gateway's decision.
- Whether the gateway pulls RTMP instead of RTSP; if so, an RTMP endpoint is
  added to phase 5.
- Whether cams should show that a camera is simulated (the serial starts with
  `SIM`); not needed now.
