# cam-sim

A container that behaves like a Reolink **RLC-1224A** camera (firmware
v3.2.0.6011_2607012059): its HTTP API, its quirks, and the failures we have
seen on the real device. It is for testing software written against the
camera, such as [cams](https://github.com/klaushofrichter/cams) and the
planned camera gateway, in CI and with several simulated cameras at once.
A bearer-token control API selects what the camera plays, triggers events and
switches faults on and off.

**Status:** Plan 1 (headless core) in progress. See the
[design spec](docs/superpowers/specs/2026-09-26-cam-sim-design.md).

## Faults

Faults are switched through the control API (`PUT /sim/api/faults/<name>`),
`CAMSIM_FAULTS` at start, or `sim.engine.faults.set()` in process. Each is on
until cleared, or for the next `count` matching requests.

| Fault | Parameters | Effect |
|---|---|---|
| `downloads.refuse` | | every Download resets |
| `downloads.dropFirst` | `count` | the next `count` Downloads reset |
| `downloads.dropMidway` | | active Download bodies are cut part-way |
| `downloads.delayMs` | `ms` | wait before sending a Download body |
| `flv.reset` | | every `/flv` connection resets, even with a valid token |
| `flv.delayMs` | `ms` | delay the `/flv` response |
| `search.delayMs` | `ms` | make Search slower (widens the `-54` window) |
| `settings.fail` | `cmds`, `rspCode` (default -67) | those Set commands answer an error |
| `settings.ignore` | `cmds` | those Set commands answer 200 and change nothing |
| `settings.strictPartial` | | a partial Set's resets show at once, not after a reboot |
| `offline` | | every camera connection is destroyed |
| `latencyMs` | `ms` | delay every camera request |
| `snap.fail` | | Snap answers 500 |

One-shot actions (`POST /sim/api/actions/<name>`): `tokens.revoke`, `reboot`
(`ms`, `dropsConnection`), `flv.dropActive`, `downloads.dropActive`.

### From the cams mock camera

| Mock option or call | cam-sim |
|---|---|
| `flvDelayMs` | `flv.delayMs` |
| `downloadDelayMs` | `downloads.delayMs` |
| `searchDelayMs` | `search.delayMs` |
| `dropFirstDownloads` | `downloads.dropFirst` with `count` |
| `settingsFailures` | `settings.fail` with `cmds` |
| `ignoreWrites` | `settings.ignore` with `cmds` |
| `rebootMs`, `rebootDropsConnection` | `reboot` action parameters |
| `state.offline = true` | `offline` |
| `state.rejectAllStreams = true` | `flv.reset` |
| `state.revokeTokens()` | `tokens.revoke` |
| `state.dropStreams()` | `flv.dropActive` |
| `state.dropDownloads()` | `downloads.dropActive` |
| partial writes visible at once | `settings.strictPartial` |

## Running it

**Docker, one camera:**

```sh
docker build -t cam-sim .
docker run --rm -p 8443:8443 -p 8080:8080 -p 9443:9443 \
  -e CAMSIM_USERS='admin:admin:<password>' -e CAMSIM_CONTROL_TOKEN='<token>' \
  -v cam-sim-data:/data cam-sim
```

The camera API is on 8443 (HTTPS) and 8080 (HTTP), the control API on 9443.
Clients reach the simulator the same way they reach a real camera: by address,
with the certificate checked against the camera's name.

**Docker, three cameras:** `docker compose up` starts `cam2`, `cam3` and
`cam4` on `127.0.0.1` (ports in `compose.yaml`). It reads `CAMSIM_USERS` and
`CAMSIM_CONTROL_TOKEN` from `.env`; nothing else from `.env` reaches the
containers.

**In a test process:**

```ts
import { createCamSim } from 'cam-sim';
const sim = await createCamSim({ users: [{ name: 'u', level: 'admin', password: 'p' }], seedClips: 'demo' });
// sim.cameraApp works with supertest; sim.listen() opens real ports.
sim.engine.faults.set({ name: 'downloads.refuse' });
await sim.close();
```

**Configuration** is by `CAMSIM_*` variables; see section 4 of the
[spec](docs/superpowers/specs/2026-09-26-cam-sim-design.md). The control API
is described in [openapi.yaml](openapi.yaml).
