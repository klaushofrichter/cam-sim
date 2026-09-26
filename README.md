# cam-sim

cam-sim is a simulated **Reolink RLC-1224A** camera (firmware
v3.2.0.6011_2607012059). It speaks the camera's HTTP API, reproduces its
quirks, and can be made to fail in the ways the real device fails. It exists to
test software written against the camera, such as
[cams](https://github.com/klaushofrichter/cams) and the planned camera
gateway, in CI and with several cameras at once.

Each simulator has two faces:

- **The simulated camera API** on the camera's ports. It answers like the real
  camera, so a client can't tell the difference.
- **The control API** on its own port, protected by a bearer token. It
  controls events, faults, power and state. Nothing on the camera ports can
  reach it.

One container is one camera. It runs headless; there is no web UI yet.

**Status:** Plan 1, the headless core, is released. Real video (Plan 2), a web
UI (Plan 3), deployment as `cam2` in the cluster (Plan 4), RTSP and ONVIF
events (Plan 5) and FTP upload (Plan 6) follow; see the
[design spec](docs/superpowers/specs/2026-09-26-cam-sim-design.md). Until
Plan 2, pictures, live video and recordings are ffmpeg **test patterns**.

## Contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Simulated camera API](#simulated-camera-api)
- [Control API](#control-api)
- [Secrets](#secrets)
- [Development](#development)

## Quick start

**Docker, one camera:**

```sh
docker run --rm -p 8443:8443 -p 8080:8080 -p 9443:9443 \
  -e CAMSIM_USERS='admin:admin:<password>' -e CAMSIM_CONTROL_TOKEN='<token>' \
  -v cam-sim-data:/data ghcr.io/klaushofrichter/cam-sim:latest
```

The camera API is on 8443 (HTTPS) and 8080 (HTTP), and the control API on
9443. Point a client at the simulator the way it would reach a real camera: by
address, with the certificate checked against the camera's name.

**Docker, three cameras:** `docker compose up` in this repository starts
`cam2`, `cam3` and `cam4` on `127.0.0.1`; the ports are in `compose.yaml`. It
reads `CAMSIM_USERS` and `CAMSIM_CONTROL_TOKEN` from `.env`, and nothing else
from `.env` reaches the containers.

**Inside a test process** (Node), with no container:

```ts
import { createCamSim } from 'cam-sim';

const sim = await createCamSim({
  users: [{ name: 'u', level: 'admin', password: 'p' }],
  seedClips: 'demo',
});
// sim.cameraApp works with supertest; sim.listen() opens real ports.
sim.engine.faults.set({ name: 'downloads.refuse' });
await sim.close();
```

Install it from a release tarball, for example
`"cam-sim": "https://github.com/klaushofrichter/cam-sim/releases/download/v2026.09.26.2/cam-sim-v2026.09.26.2.tgz"`.
In a vitest `globalSetup`, call `ensureFixtures(defaultFixtureDir(), logger)` so
the test patterns are built once, not in every worker.

## Configuration

Everything is set with `CAMSIM_*` variables. For secrets, `<NAME>_FILE`
pointing at a mounted file wins over the plain variable.

| Variable | Default | Meaning |
|---|---|---|
| `CAMSIM_USERS` / `_FILE` | required | camera users, `name:level:password` separated by `;`, level `admin` or `guest` |
| `CAMSIM_CONTROL_TOKEN` / `_FILE` | — | bearer token for the control API. **Without it the control API is off** (404) |
| `CAMSIM_NAME` | `Cam` | camera name: `GetDevInfo.name` and the on-screen name |
| `CAMSIM_TZ` | `America/Chicago` | camera time zone: `GetTime`, file names, Search times |
| `CAMSIM_SD_MB` | `4096` | simulated SD card size |
| `CAMSIM_SPEED` | `fast` | `real` adds the camera's timings: Login ~0.2 s, Search ~0.3 s, Download 150 KB/s, reboot 60 s, certificate restart 10 s. `fast` keeps the behaviour with short timings |
| `CAMSIM_SEED_CLIPS` | `none` | `demo`: start with six recordings, four today and two yesterday |
| `CAMSIM_AUTO_EVENTS` | `off` | background events, e.g. `motion:6/h,person:1/h` |
| `CAMSIM_FAULTS` | `[]` | faults switched on at start, as JSON, e.g. `[{"name":"downloads.refuse"}]` |
| `CAMSIM_FIRMWARE` | `v3.2.0.6011_2607012059` | the firmware version reported |
| `CAMSIM_SEED` | time | seed for serials and the reboot coin flip |
| `CAMSIM_DATA_DIR` | `/data` in the image | persistent settings, SD card index and certificates; unset means in memory |
| `CAMSIM_TLS_CERT_FILE` / `_KEY_FILE` | — | certificate at start; otherwise the one stored by `ImportCertificate`; otherwise a factory-style self-signed one (`CN=CERTIFICATE`) |
| `CAMSIM_HTTPS_PORT` | `8443` | camera HTTPS |
| `CAMSIM_HTTP_PORT` | `8080` | camera HTTP |
| `CAMSIM_CONTROL_PORT` | `9443` | control API |
| `CAMSIM_CONTROL_TLS` | `auto` | `auto`: TLS on the control port only with `CAMSIM_TLS_CERT_FILE`; `on`: always, with the camera's current certificate, following `ImportCertificate`; `off` |
| `CAMSIM_FIXTURE_DIR` | temp dir | where the test-pattern media is built |
| `CAMSIM_LOG_LEVEL` | `info` | pino log level; logs never contain tokens, passwords or request URLs |

`CAMSIM_MEDIA=video` (Plan 2) and `CAMSIM_WEB_UI=true` (Plan 3) are refused
until they exist.

## Simulated camera API

This is the Reolink HTTP API as the real RLC-1224A answers it. The authority
is [cams' guide to the real camera](https://github.com/klaushofrichter/cams/blob/main/docs/reolink-api.md);
this section follows its structure and notes where the simulator differs.

The examples assume:

```sh
CAM=127.0.0.1:8443   # a simulator's HTTPS port
post() { local param=${2:-'{}'}; curl -sk -X POST "https://$CAM/cgi-bin/api.cgi?cmd=$1&token=$TOKEN" \
  -H 'Content-Type: application/json' -d "[{\"cmd\":\"$1\",\"action\":0,\"param\":$param}]"; }
```

### Basics

JSON commands are `POST /cgi-bin/api.cgi?cmd=<Cmd>&token=<token>` with a JSON
**array** body; the reply is an array in the same order.

```json
[{ "cmd": "GetDevInfo", "action": 0, "param": {} }]
```

```json
[{ "cmd": "GetDevInfo", "code": 0, "value": { "DevInfo": { "model": "RLC-1224A", "firmVer": "v3.2.0.6011_2607012059", "serial": "SIM3F0A…", "name": "Cam", "…": "…" } } }]
```

- **Every JSON reply is `Content-Type: text/html`**, as on the camera.
- On failure `code` is 1 and `error.rspCode` is negative:
  `[{"cmd":"Search","code":1,"error":{"detail":"the respode of msg is err","rspCode":-54}}]`.
- **Unknown commands** answer `[{"cmd":"Unknown","code":1,"error":{"detail":"not support","rspCode":-9}}]`.
- A body that isn't JSON answers `-4` ("param error"). Any `Content-Type` is accepted.
- A body with several entries is answered in one array.

### Ports and services

| Service | Container port | Camera port (`GetNetPort`) | Serves |
|---|---|---|---|
| HTTPS | 8443 | 443 | the whole API |
| HTTP | 8080 | 80 | the whole API |
| RTMP | — | 1935 | behind `/flv`, as on the camera |
| RTSP | — (Plan 5) | 554 | |
| ONVIF | — (Plan 5) | 8000 | |

`GetNetPort` reports the camera's ports, not the container's. `SetNetPort`
switches services the way the camera does:

- `httpEnable: 0`: the HTTP port drops connections, and **Download** drops on
  HTTPS too (the camera needs HTTP for downloads).
- `httpsEnable: 0`: the HTTPS port drops connections.
- `rtmpEnable: 0`: `/flv` drops the connection.

### Login and tokens

```sh
TOKEN=$(curl -sk -X POST "https://$CAM/cgi-bin/api.cgi?cmd=Login" -H 'Content-Type: application/json' \
  -d '[{"cmd":"Login","action":0,"param":{"User":{"Version":"0","userName":"admin","password":"<password>"}}}]' \
  | jq -r '.[0].value.Token.name')
post Logout
```

- The reply carries only `value.Token`: `name` (16 hex characters) and
  `leaseTime: 3600` (seconds). A wrong user or password answers
  `{"detail":"login failed","rspCode":-7}`.
- Every other request carries `token=` in the query string; there is no header
  alternative.
- **Sessions accumulate** until their lease ends. `GetOnline` lists them:
  `{"User":[{"canbeDisconn":0,"ip":"…","level":"admin","sessionId":10,"userName":"admin"}]}`.
- A token ends with any of:
  - `Logout`, or the end of its lease;
  - a password change, or deletion of its user;
  - a reboot or a power cycle;
  - `CertificateClear`, or a successful `ImportCertificate`.

### Token rejection: four shapes

| Endpoint | Invalid or expired token |
|---|---|
| JSON commands (`POST`) | `code: 1`, `rspCode: -6`, detail "please login first" |
| `GET ?cmd=Snap` | **HTTP 200**, `text/html`, body `[{"code":1,"error":{"rspCode":-6,"detail":"please login first"}}]` |
| `GET /flv?…` | **no HTTP response**: the connection is reset |
| `GET ?cmd=Download` | **HTTP 401**, `text/html`, empty body |

### Commands

| Area | Command | `param` | `value` of the reply |
|---|---|---|---|
| Session | `Login` | `{User:{userName,password}}` | `{Token:{leaseTime,name}}` |
| | `Logout` | `{}` | `{rspCode:200}` |
| | `GetOnline` | `{}` | `{User:[…]}` |
| Users | `GetUser` | `{}` | `{CurUser:{User},User:[{level,userName}]}` |
| | `AddUser` | `{User:{userName,password,level}}` | `{rspCode:200}`; `-4` for a duplicate or invalid user |
| | `DelUser` | `{User:{userName}}` | `{rspCode:200}` |
| | `ModifyUser` | `{User:{userName,password?,level?}}` | `{rspCode:200}`; a new password ends that user's sessions |
| Device | `GetDevInfo` | `{}` | `{DevInfo:{model,firmVer,hardVer,serial,name,…}}`; the serial starts with `SIM` and changes at every boot |
| | `GetTime` | `{}` | `{Dst:{enable,offset,…},Time:{year,mon,day,hour,min,sec,isDst,timeZone,…}}`; `timeZone` is seconds **west** of UTC (Chicago: 21600) |
| | `GetHddInfo` | `{}` | `{HddInfo:[{capacity,size,mount,format,number,storageType}]}`; MB, **`size` is the free space** |
| | `GetEnc` | `{channel:0}` | `{Enc:{mainStream:{vType:"h265",size:"4512*2512",frameRate:20,…},subStream:{vType:"h264",size:"896*512",frameRate:10,…}}}` |
| | `GetNetPort` / `SetNetPort` | `{}` / `{NetPort:{…}}` | ports and `*Enable` flags |
| | `GetAbility` | `{User:{userName}}` | the camera's capability flags |
| | `Reboot` | `{}` | `{rspCode:200}`, **or the connection drops first** (half the time, seeded) |
| Recording | `GetRecV20` / `SetRecV20` | `{channel:0}` / `{Rec:{…}}` | `enable`, `postRec`, `preRec`, `saveDay`, `schedule.table` (168 characters per trigger type) |
| | `Search` | see [Search](#recordings-search) | `{SearchResult:{…}}` |
| | `CheckDownload` | `{filename}` | `{downloadTask:0\|1}`; `-4` for an unknown name |
| Detection | `GetMdAlarm` / `SetMdAlarm` | `{channel:0}` / `{MdAlarm:{…}}` | `newSens.sensDef` 1–50, **lower is more sensitive** |
| | `GetAiAlarm` / `SetAiAlarm` | `{channel:0,ai_type}` / `{AiAlarm:{…,ai_type}}` | per `people`, `vehicle`, `dog_cat`; `sensitivity` 0–100 |
| | `GetMdState` | `{channel:0}` | `{state:0\|1}`: 1 while an event is active |
| | `GetAiState` | `{channel:0}` | `{channel:0,people:{alarm_state,support},vehicle:{…},dog_cat:{…},face:{alarm_state:0,support:0}}` |
| Image and lights | `GetIsp` / `SetIsp` | `{channel:0}` / `{Isp:{…}}` | `dayNight` `Auto`, `Color`, `Black&White`; `rotation`, `mirroring`, … |
| | `GetIrLights` / `SetIrLights` | `{channel:0}` / `{IrLights:{state}}` | `Auto`, `Off`; the reply also carries `initial` and `range`, as on the camera |
| | `GetWhiteLed` / `SetWhiteLed` | `{channel:0}` / `{WhiteLed:{…}}` | `mode` 0–3, `bright` 0–100 |
| | `GetOsd` / `SetOsd` | `{channel:0}` / `{Osd:{…}}` | positions `Upper Left` … `Lower Right`; name ≤ 31 bytes |
| FTP | `GetFtpV20` / `SetFtpV20` | `{}` / `{Ftp:{…}}` | stored only, until Plan 6; `server: ""` answers `-4` |
| Certificates | `GetCertificateInfo` | `{}` | `{CertificateInfo:{crtName,enable,keyName}}`; `enable` is 1 once one is installed |
| | `CertificateClear` | `{}` | back to the factory certificate; sessions end; offline ~10 s (real speed) |
| | `ImportCertificate` | `{importCertificate:{crt:{size,name,content},key:{…}}}` | `content` is base64 PEM. **Importing over an installed certificate answers 200 and changes nothing**, as on the camera; clear first. A key that doesn't match answers `-4` |

Not supported, as on this firmware: `GetFtp` and `TestFtpV20` (`-9`). For now,
`TestFtp` (Plan 6) and `CheckFirmware` (its reply isn't captured yet) also
answer `-9`.

### Settings: always write the whole object

A `Set` answers `code 0, rspCode 200` for a partial object, and an immediate
re-read looks right. But **the keys you leave out are reset in the saved
configuration**, which takes effect at the next reboot or power-on (measured
on the real camera). Read the object, change your keys, and send the whole
object back.

Invalid values are rejected and the old value stays:
- `sensDef` outside 1–50, or `bright` outside 0–100: `-56`;
- an unknown `dayNight`, OSD position, IR state or `ai_type`: `-67`.

### Live video

```
GET /flv?port=1935&app=bcs&stream=channel0_<sub|main>.bcs&token=<t>
```

This is an endless `video/x-flv` response, paced in real time.

- **sub** is H.264 (codec id 7) + AAC.
- **main** is H.265 in FLV with the **legacy codec id 12**, the camera's
  vendor extension. mpegts.js 1.8+ plays it; ffmpeg can't read it.
- A viewer that stops reading is dropped instead of being buffered for.

### Snapshots

```sh
curl -sk "https://$CAM/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=$RANDOM&token=$TOKEN" -o snap.jpg
```

The reply is `image/jpeg`. A bad token gets 200 `text/html` with the `-6` body.

### Recordings: Search

**Days with recordings in a month** (`onlyStatus: 1`):

```sh
post Search '{"Search":{"channel":0,"onlyStatus":1,"streamType":"main",
  "StartTime":{"year":2026,"mon":9,"day":1,"hour":0,"min":0,"sec":0},
  "EndTime":{"year":2026,"mon":9,"day":30,"hour":23,"min":59,"sec":59}}}'
# → {"SearchResult":{"channel":0,"Status":[{"year":2026,"mon":9,"table":"000000000000000000000000110000"}]}}
```

**Clips of one day** (`onlyStatus: 0`):

```json
{ "SearchResult": { "channel": 0, "File": [ {
  "name": "/mnt/sda/Mp4Record/2026-09-26/RecS0A_DST20260926_065221_065241_0_55148080000000_AAE60.mp4",
  "size": "700000", "type": "sub", "frameRate": 0, "width": 0, "height": 0,
  "StartTime": { "year": 2026, "mon": 9, "day": 26, "hour": 6, "min": 52, "sec": 21 },
  "EndTime":   { "year": 2026, "mon": 9, "day": 26, "hour": 6, "min": 52, "sec": 41 } } ] } }
```

- **One Search at a time, across the whole camera.** An overlapping Search
  answers `-54`, and the one already running comes back with no `File`.
- `size` is a string. A day without clips has **no `File` key**.
- A recording still in progress is listed with end `000000`.
- The main copy of a recording ends 2 s after the sub copy.
- A clip that crosses midnight is named by its start date, and its `EndTime`
  is on the next day.

### Recording file names

```
/mnt/sda/Mp4Record/2026-09-26/RecS0A_DST20260926_065221_065241_0_55148080000000_AAE60.mp4
```

The name is made of, in order:
- `RecS` for the sub stream, or `RecM` for main;
- the name version `0A`;
- `DST` when daylight saving time applies on that date;
- the date, the start and the end;
- `0`;
- 14 hex digits of flags;
- the size in hex.

Trigger bits are bit `55 − pos`: person 17, vehicle 19, pet 20, motion 24. AI
events also set the motion bit.

### Recordings: Download

```
GET /cgi-bin/api.cgi?cmd=Download&source=<full name>&output=<file>.mp4&token=<t>
```

The reply is `200 video/mp4` with a Content-Length: a fragmented MP4 that
starts with `ftyp mp42`. Its byte count differs from the Search `size`, as on
the camera.

- **Send `source` unencoded.** A percent-encoded path (`%2F`) resets the
  connection.
- **One Download at a time, across the whole camera**; a second one resets.
- `cmd=download` (lowercase) works. `cmd=Playback` answers 404.
- `user=…&password=…` instead of a token answers 404.
- A name that isn't on the card, including any `..` path, resets the
  connection.

### What differs from the real camera

- **Pictures:** they're test patterns until Plan 2. The main stream's fixture
  is 1280×720, while `GetEnc` still reports 4512×2512.
- **Recordings:** they start at the event, not a few seconds before. An event
  during a recording extends it instead of starting an overlapping clip.
- **Not measured on the real camera, so chosen:**
  - the error details for `-7` and `-67`;
  - the reset values of keys that were never measured;
  - Download's Content-Length;
  - the DST marker, taken per date rather than per instant.

## Control API

Base URL `http(s)://<host>:9443/sim/api`. Every request needs
`Authorization: Bearer <CAMSIM_CONTROL_TOKEN>`:

- a missing or wrong token answers 401 `{"error":"unauthorized"}`;
- a token in the URL (`?token=` or `?access_token=`) answers 400 `{"error":"token_in_url"}`;
- without a configured token, every route answers 404.

The full schema is in [openapi.yaml](openapi.yaml).

```sh
ctl() { curl -s -H "Authorization: Bearer $CAMSIM_CONTROL_TOKEN" -H 'Content-Type: application/json' "$@"; }
C=http://127.0.0.1:9443/sim/api
```

### State

`GET /sim/api/state`

```json
{
  "name": "Cam", "serial": "SIM3F0A…", "model": "RLC-1224A", "firmVer": "v3.2.0.6011_2607012059",
  "offline": false, "power": "on", "rebooting": false,
  "faults": [], "events": [],
  "sd": { "usedMb": 8, "capacityMb": 4096, "recordings": 6 },
  "counters": { "logins": 1, "loginAttempts": 1, "activeSessions": 1, "devInfoCalls": 0,
                "activeStreams": 0, "streamsOpened": 0, "downloads": 0, "activeDownloads": 0,
                "droppedDownloads": 0, "downloadOrder": [], "searches": 0, "setCalls": [], "reboots": 0 },
  "certificate": { "source": "factory", "enable": 0 },
  "settings": { "Rec": { "…": "…" }, "Isp": { "…": "…" } }
}
```

- `power` is `on`, `off` or `booting`.
- `settings` are the running values.
- `downloadOrder` and `setCalls` keep the latest 1000 entries.

`GET /healthz` needs no token and answers `{"ok":true}`, for probes.

### Power and one-shot actions

`POST /sim/api/actions/<name>`

| Action | Body | Answer | Effect |
|---|---|---|---|
| `reboot` | `{"ms":1000,"dropsConnection":false}` (optional) | 202 | offline for `ms` (default: 1 s fast, 60 s real), then a new serial, no sessions, and the saved settings take effect. 409 `powered_off` while off |
| `power-off` | — | 204 | the camera goes dark: every connection drops, sessions end, the recording in progress is closed, background events pause, and new events are refused. 409 `already_off` |
| `power-on` | `{"ms":1000}` (optional) | 202 | boots like a reboot (`power` is `booting`, then `on`), and background events resume. 409 `already_on` |
| `tokens.revoke` | — | 204 | every session ends |
| `flv.dropActive` | — | 204 | open live streams are cut |
| `downloads.dropActive` | — | 204 | downloads in flight are cut |

```sh
ctl -X POST $C/actions/power-off
ctl -X POST $C/actions/power-on -d '{"ms":5000}'
ctl -X POST $C/actions/reboot -d '{"ms":2000,"dropsConnection":true}'
```

The camera's own `Reboot` command behaves like `reboot`, with the speed's
timing and a 50/50 chance of dropping the connection before it answers.

### Events

`POST /sim/api/events` with `{"type":"motion|person|vehicle|pet","durationS":1–3600}`
answers 201 `{event, recording}`.

- The event sets `GetMdState`, and `GetAiState` for AI types.
- It starts or extends a recording when `Rec.enable` is 1 and the schedule
  allows that type at that hour of the week. Otherwise `recording` is `null`.
- The recording ends `postRec` after the event.
- While the camera is off, the answer is 409 `powered_off`.

`GET /sim/api/events?limit=50` lists recent events, newest first.

```sh
ctl -X POST $C/events -d '{"type":"person","durationS":8}'
```

### Recordings

| Route | Body | Effect |
|---|---|---|
| `POST /sim/api/recordings/seed` | `{"clips":"demo"}` or `{"clips":[{"daysAgo":1,"start":"070000","end":"070030","triggers":["motion"],"mainEnd":"070032"}]}` | adds past recordings; 201 `{"added":n}` |
| `DELETE /sim/api/recordings` | — | empties the SD card; 204 |

### Faults

| Route | Effect |
|---|---|
| `GET /sim/api/faults` | the active faults |
| `PUT /sim/api/faults/<name>` | switches a fault on; the body holds its parameters; 200 with the fault |
| `DELETE /sim/api/faults/<name>` | switches it off; 204 |
| `DELETE /sim/api/faults` | switches all off; 204 |

A fault stays on until cleared, or, with `count`, applies only to the next N
matching requests.

| Fault | Parameters | Effect |
|---|---|---|
| `downloads.refuse` | | every Download resets (the real camera's state since 2026-09-26) |
| `downloads.dropFirst` | `count` | the next `count` Downloads reset |
| `downloads.dropMidway` | | Download bodies are cut part-way |
| `downloads.delayMs` | `ms` | wait before sending a Download body |
| `flv.reset` | | every `/flv` connection resets, even with a valid token |
| `flv.delayMs` | `ms` | delay the `/flv` response |
| `search.delayMs` | `ms` | make Search slower (widens the `-54` window) |
| `settings.fail` | `cmds`, `rspCode` (default -67) | those Set commands answer an error |
| `settings.ignore` | `cmds` | those Set commands answer 200 and change nothing |
| `settings.strictPartial` | | a partial Set's resets show at once, not after a reboot |
| `offline` | | every camera connection is destroyed (the camera stays powered) |
| `latencyMs` | `ms` | delay every camera request |
| `snap.fail` | | Snap answers 500 |

```sh
ctl -X PUT $C/faults/settings.fail -d '{"cmds":["SetWhiteLed"]}'
ctl -X PUT $C/faults/downloads.dropFirst -d '{"count":2}'
```

### Reset, request log, live feed

- `POST /sim/api/reset` with `{"settings":true,"recordings":true,"counters":true,"faults":true}`
  answers 204. An empty body resets all four.
- `GET /sim/api/requests?limit=100` lists recent camera API requests: time,
  port, method, path **without the query**, command, status and duration.
  Tokens and passwords never appear.
- `GET /sim/api/stream` is Server-Sent Events: `state` (sent first, then on
  every change), `event`, `request` and `fault`, each with an `id:`.

### From the cams mock camera

| Mock option or call | cam-sim |
|---|---|
| `flvDelayMs` | `flv.delayMs` |
| `downloadDelayMs` | `downloads.delayMs` |
| `searchDelayMs` | `search.delayMs` |
| `dropFirstDownloads` | `downloads.dropFirst` with `count` |
| `settingsFailures` | `settings.fail` with `cmds` |
| `ignoreWrites` | `settings.ignore` with `cmds` |
| `rebootMs`, `rebootDropsConnection` | `createCamSim({ reboot: { ms, dropsConnection } })`, or the `reboot` action's parameters |
| `state.offline = true` | `offline` |
| `state.rejectAllStreams = true` | `flv.reset` |
| `state.revokeTokens()` | `tokens.revoke` |
| `state.dropStreams()` | `flv.dropActive` |
| `state.dropDownloads()` | `downloads.dropActive` |
| partial writes visible at once | `settings.strictPartial` |

## Secrets

`.env` holds the values for deployments. It's mode 600 and never committed;
see `.env.example`. `scripts/sync-secrets.sh`:

- fills empty values and placeholders;
- sets the GitHub Actions secrets `CAMSIM_CONTROL_TOKEN`, `CAMSIM_USERS` and
  `GITHUB_KUBE_SETUP_PAT`;
- applies the Kubernetes Secret `cam-sim-secrets`, with the `CAMSIM_*` values
  only.

It prints key names only, and `--dry-run` shows what it would do.
`REOLINK_PASSWORD` and `CAMSIM_GITHUB_PAT` are never synced.

## Development

```sh
npm ci
npm test                 # vitest; needs ffmpeg for the fixtures
npm run build
scripts/container-smoke.sh
```

CI runs:
- the tests;
- CodeQL;
- the container smoke test;
- **cams' own unit and e2e suites against the cam-sim build**
  (`.github/workflows/cams-compat.yml`).

No media file of any kind is committed or published; the test patterns are
generated.

MIT licence.
