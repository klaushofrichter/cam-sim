# cam-sim Plan 1: Headless core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A container and an in-process library that behave like the Reolink RLC-1224A for everything cams uses today (no real video yet), driven by a bearer-token control API, good enough that cams' unit and e2e suites pass against it instead of cams' own mock camera.

**Architecture:** A pure TypeScript **engine** (identity, clock, sessions, settings, SD card, events, faults, counters) sits behind three thin surfaces: the Reolink-compatible **camera API** (Express, served on HTTP and HTTPS listeners), the **control API** (Express, bearer token, SSE), and an **in-process API** (`createCamSim`) for unit tests. Media comes from a `MediaSource` interface; this plan implements only `FixtureMedia`, which serves test-pattern files generated once by ffmpeg and cached.

**Tech Stack:** Node 26, TypeScript 7 (`tsc`, CommonJS, like cams), Express 5, pino, vitest 5, supertest, `selfsigned` (factory certificate), ffmpeg (fixture generation only), Docker (multi-arch), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-26-cam-sim-design.md` (phase 1 of section 17; sections 1–9, 12–17). Firmware reference replies: `reference/rlc-1224a/*.json` (captured 2026-09-26 from the real camera, redacted, **gitignored until Klaus reviews them**).

## Global Constraints

- Node 26, TypeScript 7, Express 5, CommonJS, `tsc` build to `dist/` — same toolchain as `~/Development/cams`.
- Firmware identity: model `RLC-1224A`, firmVer `v3.2.0.6011_2607012059`, hardVer `IPC_NT18NA612MP`, buildDay `build 2607012059`. Serial starts with `SIM` and changes on every reboot.
- **Every JSON reply of the camera API has `Content-Type: text/html`** (measured). Unknown commands answer `[{"cmd":"Unknown","code":1,"error":{"detail":"not support","rspCode":-9}}]` (measured).
- Rejection shapes (spec 7.2): JSON `-6` "please login first"; Snap 200 `text/html` with body `[{"code":1,"error":{"rspCode":-6,"detail":"please login first"}}]`; `/flv` socket destroyed; Download 401 `text/html` empty body.
- Quirks are always on; faults only via control API, `CAMSIM_FAULTS` at start, or the in-process engine. Never via the camera API.
- Control API: `Authorization: Bearer <token>` only, constant-time compare, token never accepted from a URL. No token configured → control API routes answer 404 (disabled), `/healthz` still works.
- Never log or store tokens, passwords or full camera URLs. Request logs keep `cmd`, method, path (no query), status, duration.
- **No media and no camera-captured content is committed, released or uploaded as a CI artifact.** Fixtures are generated at first use from ffmpeg test patterns (`testsrc2`, `sine`). `reference/` stays gitignored.
- GitHub repo `klaushofrichter/cam-sim` is **public** from the start, with the CodeQL gate from the first PR.
- Commit messages end with the attribution lines from the session's system reminder.

## Review Focus

1. **Path traversal in Download `source`** (`/mnt/sda/Mp4Record/../../etc/passwd`, absolute paths outside the SD root): must answer like a missing file (connection reset), never read outside the SD card. → Task 9 test.
2. **Secrets leaking into logs or `/sim/api/requests`**: a Login with a password and a request with `token=` must leave no trace of either in pino output or the request log. → Task 11 test.
3. **DST and midnight boundaries in file names**: an event at 23:59:50 local that runs past midnight, and a clip on the DST change day, must get the same names the firmware would (date of the start, `DST` marker by the start date). → Task 6 test.
4. **Device-wide serialization across tokens**: two Searches from *different* sessions overlap → the second gets `-54` and the first returns no `File`; two concurrent Downloads from different sessions → the second resets. → Task 9 test.
5. **Corrupt persistent state**: a truncated `/data/settings.json` or `/data/sd/index.json` at start must fall back to factory state with a warning log, not crash. → Task 5 and Task 6 tests.

---

## File Structure

```
cam-sim/
  package.json, tsconfig.json, vitest.config.mts, .gitignore, .dockerignore
  README.md, CHANGELOG.md, LICENSE (MIT), .env.example
  Dockerfile, compose.yaml, openapi.yaml
  scripts/sync-secrets.sh
  .github/workflows/pr-checks.yml, build-push.yml
  .github/codeql-accepted.tsv
  src/
    index.ts                 createCamSim() — the in-process API (package entry)
    cli.ts                   container / npx entry: config → createCamSim → listen
    config.ts                CAMSIM_* env parsing and validation
    log.ts                   pino logger with redaction
    profile/rlc1224a.ts      static identity, factory settings, GetEnc/GetNetPort/GetTime shapes
    profile/ability.json     GetAbility reply (from reference, redacted)
    engine/clock.ts          Clock: now(), camera-local parts, DST, GetTime value
    engine/rng.ts            seeded RNG (serials, reboot coin flip)
    engine/sessions.ts       users, tokens, leases, GetOnline
    engine/settings.ts       running vs saved objects, whole-object semantics, validation, persistence
    engine/sdcard.ts         recordings index, names, flags, Search, retention, HddInfo, seeding
    engine/events.ts         events → recordings, MdState/AiState
    engine/faults.ts         fault registry (on / next-N / params)
    engine/counters.ts       counters for /sim/api/state
    engine/engine.ts         composes the above; reboot; certificate state
    media/flv.ts             FLV reader (tags) + writer (H.264 id 7, H.265 legacy id 12, AAC)
    media/source.ts          MediaSource interface
    media/fixtures.ts        FixtureMedia: ensureFixtures() via ffmpeg, cache dir
    camera-api/app.ts        Express app: middleware (offline, latency), routes
    camera-api/commands.ts   POST /cgi-bin/api.cgi dispatch table
    camera-api/media-routes.ts  GET Snap, Download, /flv
    camera-api/listeners.ts  HTTP + HTTPS servers, NetPort enable flags, TLS context swap
    tls/certs.ts             factory self-signed, imported cert, env cert
    control-api/app.ts       /sim/api routes, auth, /healthz
    control-api/sse.ts       /sim/api/stream
    control-api/request-log.ts
  test/                      vitest, one file per module (+ conformance/)
  reference/rlc-1224a/       (gitignored) captured firmware replies
```

---

### Task 1: Repository scaffold, toolchain, CI skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.mts`, `.dockerignore`, `README.md`, `CHANGELOG.md`, `LICENSE`, `src/index.ts` (stub), `test/smoke.test.ts`, `.github/workflows/pr-checks.yml`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm test`, `npm run build`, `npm run lint:types` scripts used by all later tasks and CI.

- [ ] **Step 1: package.json**

```json
{
  "name": "cam-sim",
  "version": "0.0.0",
  "private": true,
  "description": "Simulator for the Reolink RLC-1224A camera: its HTTP API, quirks and faults, for testing cams and the camera gateway.",
  "license": "MIT",
  "type": "commonjs",
  "main": "dist/src/index.js",
  "types": "dist/src/index.d.ts",
  "bin": { "cam-sim": "dist/src/cli.js" },
  "files": ["dist/src", "openapi.yaml"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepare": "tsc -p tsconfig.json",
    "start": "node dist/src/cli.js",
    "dev": "tsx --env-file-if-exists=.env src/cli.ts",
    "test": "vitest run",
    "lint:types": "tsc --noEmit -p tsconfig.json"
  }
}
```

Install: `npm i express pino selfsigned` and `npm i -D typescript@^7 vitest@^5 tsx supertest @types/express @types/supertest @types/node`. (`prepare` builds `dist/` when cams installs cam-sim as a git dependency.)

- [ ] **Step 2: tsconfig.json** — copy cams' `tsconfig.json` settings (strict, `module: commonjs`, `target: es2023`, `outDir: dist`, `declaration: true`), `include: ["src", "test"]`, `resolveJsonModule: true`.

- [ ] **Step 3: Smoke test and stub**

```ts
// test/smoke.test.ts
import { describe, it, expect } from 'vitest';
import * as camSim from '../src/index';
describe('package', () => {
  it('exports createCamSim', () => expect(typeof camSim.createCamSim).toBe('function'));
});
```

```ts
// src/index.ts (stub, replaced in Task 12)
export function createCamSim(): never { throw new Error('not implemented'); }
```

- [ ] **Step 4: Run** `npm test && npm run build` — expect PASS and `dist/src/index.js`.

- [ ] **Step 5: CI** `.github/workflows/pr-checks.yml`: on `pull_request` to `main`, top-level `permissions: contents: read`, job `test` (checkout, setup-node 26, `npm ci`, ensure ffmpeg like cams, `npm test`, `npm run build`, `npm audit --audit-level=high`). A `codeql` job copied from cams' `production-checks.yml` with an empty `.github/codeql-accepted.tsv`.

- [ ] **Step 6: .gitignore / .dockerignore** — keep existing entries; add `dist/`, `coverage/`. `.dockerignore`: `node_modules`, `dist`, `.git`, `.env*`, `reference`, `library`, `.superpowers`, `test-results`.

- [ ] **Step 7: README, CHANGELOG, LICENSE** — README: one paragraph purpose, "status: Plan 1 in progress", link to the spec. CHANGELOG with `## Unreleased`. MIT LICENSE (Klaus Hofrichter, 2026).

- [ ] **Step 8: Commit** `chore: scaffold cam-sim`

- [ ] **Step 9: GitHub repo** — `gh repo create klaushofrichter/cam-sim --public --source . --push`. Branch protection on `main` like cams (PR required, `test` check required). Confirm with `git ls-files | grep -Ei '\.(mp4|flv|jpg|h26[45]|aac)$'` printing nothing before the push.

---

### Task 2: Config, logger, clock, RNG

**Files:**
- Create: `src/config.ts`, `src/log.ts`, `src/engine/clock.ts`, `src/engine/rng.ts`
- Test: `test/config.test.ts`, `test/clock.test.ts`, `test/log.test.ts`

**Interfaces:**
- Produces:
  - `interface User { name: string; level: 'admin' | 'guest'; password: string }`
  - `interface CamSimConfig { name: string; users: User[]; controlToken?: string; webUi: boolean; media: 'fixture' | 'video'; dataDir?: string; tz: string; sdMb: number; speed: 'fast' | 'real'; seedClips: 'none' | 'demo'; faults: FaultSpec[]; firmVer: string; seed: number; tlsCertFile?: string; tlsKeyFile?: string; ports: { https: number; http: number; control: number }; logLevel: string }` (`FaultSpec` from Task 7; declare it in `src/engine/faults.ts` as a type-only stub now)
  - `loadConfig(env: NodeJS.ProcessEnv, readFile?: (p: string) => string): CamSimConfig` — throws `ConfigError` with a message naming the variable (never its value).
  - `createLogger(level: string, dest?: pino.DestinationStream): pino.Logger` — redacts `password`, `token`, `authorization`, `*.password`, `*.token`, `req.headers.authorization`, `req.url`.
  - `interface Clock { now(): Date }`, `systemClock`, `fixedClock(d: Date)`, and helpers:
    - `localParts(clock: Clock, tz: string, d?: Date): { date: 'YYYY-MM-DD'; hms: 'HHMMSS'; year; mon; day; hour; min; sec; dst: boolean }`
    - `isDstOn(tz: string, date: 'YYYY-MM-DD'): boolean` — evaluated at 12:00 UTC of that date (as the cams mock does)
    - `timeValue(clock, tz)` — the `GetTime` value: `{ Dst: {…}, Time: { year, mon, day, hour, min, sec, hourFmt: 1, isDst, timeFmt: 'MM/DD/YYYY', timeZone } }`; `timeZone` = seconds **west** of UTC for standard time (America/Chicago → 21600); `Dst` block copied from `reference/rlc-1224a/GetTime.json` (start 2nd Sunday March 02:00, end 1st Sunday November 02:00, `offset: 1`), `enable: 1` when the zone has DST (January and July offsets differ), else `enable: 0`.
  - `createRng(seed: number): { next(): number; hex(n: number): string }` (mulberry32).

- [ ] **Step 1: Failing tests** — `test/config.test.ts`:
  - `CAMSIM_USERS='admin:admin:pw1;cams:admin:pw2'` → two users; `admin:root:x` → ConfigError mentioning `CAMSIM_USERS` and not `x`.
  - `CAMSIM_CONTROL_TOKEN_FILE=/f` with `readFile` returning `tok\n` → `controlToken === 'tok'`; file wins over `CAMSIM_CONTROL_TOKEN`.
  - Missing `CAMSIM_USERS` → ConfigError. Defaults: name `Cam`, tz `America/Chicago`, sdMb 4096, speed `fast`, media `fixture` **(ruling: default `fixture` in Plan 1, since `video` doesn't exist yet; Plan 2 switches the default)**, ports 8443/8080/9443, seed from `CAMSIM_SEED` or `Date.now()`.
  - `CAMSIM_FAULTS='[{"name":"downloads.refuse"}]'` parses; invalid JSON → ConfigError.
  `test/clock.test.ts`:
  - 2026-09-26T21:45:27Z in America/Chicago → `hms '164527'`, `dst true`, `timeValue(...).Time.timeZone === 21600`.
  - `isDstOn('America/Chicago','2026-11-01') === false` (change day → noon UTC is 06:00/07:00 local, after the change), `'2026-03-08'` → true.
  - `Europe/Berlin` → `timeZone === -3600`.
  `test/log.test.ts`: log `{ password: 'pw', token: 'tk', req: { url: '/x?token=tk' } }` into a memory stream; output contains neither `pw` nor `tk`.

- [ ] **Step 2: Run** `npx vitest run test/config.test.ts test/clock.test.ts test/log.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement.** Clock parts via `Intl.DateTimeFormat(…, { timeZone, hourCycle: 'h23', … }).formatToParts`; DST by comparing the zone offset at the instant with the smaller of the January/July offsets (`Intl` `timeZoneName: 'longOffset'`). Users parse: split `;`, then first two `:` (password may contain `:`).

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: config, logger, clock`

---

### Task 3: Firmware profile

**Files:**
- Create: `src/profile/rlc1224a.ts`, `src/profile/ability.json`
- Test: `test/profile.test.ts`

**Interfaces:**
- Produces:
  - `FIRMWARE = { model: 'RLC-1224A', firmVer: 'v3.2.0.6011_2607012059', hardVer: 'IPC_NT18NA612MP', buildDay: 'build 2607012059', cfgVer: 'v3.2.0.0', detail: 'IPC_NT18NA612MPS18T2C0E1W011000' }`
  - `devInfo(name: string, serial: string, firmVer: string)` → the full `DevInfo` object with every key from `reference/rlc-1224a/GetDevInfo.json` (`B485: 0, IOInputNum: 0, IOOutputNum: 0, audioNum: 1, channelNum: 1, diskNum: 1, exactType: 'IPC', frameworkVer: 1, itemNo: '', pakSuffix: 'pak,paks', type: 'IPC', wifi: 0, …`).
  - `ENC` (the `Enc` value from `GetEnc.json`), `DEFAULT_NET_PORT` (`NetPort` from `GetNetPort.json`), `ABILITY` (import of `ability.json`).
  - `factorySettings(name: string): Settings` — the **running values measured on the real camera** (from the reference `GetRecV20`, `GetMdAlarm`, `GetAiAlarm` ×3 (`people`, `vehicle`, `dog_cat`), `GetIsp`, `GetIrLights`, `GetWhiteLed`, `GetOsd` with `osdChannel.name = name`, `GetFtpV20` with `enable: 0` and empty `server`/`userName`/`password`/`remoteDir`), including every key the camera returns (e.g. `Isp.bd_day`, `MdAlarm.newSens.sens[]`, `MdAlarm.scope`, `Rec.schedule.table.AI_CROSSLINE_0`, `WhiteLed.NewLightAlarm`). **Also `NetPort`.**
  - `resetDefaults(): Settings` — what a partial Set leaves in omitted keys: start from cams' `firmwareDefaults()` (`test/mock-camera/server.ts:121-132`) for the keys measured there (`Isp.rotation 1`, `Isp.mirroring 1`, `Osd.watermark 0`, `AiAlarm.stay_time 0`, …) and zero/empty values of the same type for every other key (numbers 0, strings `''`, schedule tables `'0'×168`).
  - `type Settings = { Rec; MdAlarm; AiAlarm: { people; vehicle; dog_cat }; Isp; IrLights; WhiteLed; Osd; Ftp; NetPort }` (plain JSON objects; typed as `Record<string, unknown>` at the leaves).
  - `IR_LIGHTS_EXTRA = { initial: { IrLights: { state: 'Auto' } }, range: { IrLights: { state: ['Auto', 'Off'] } } }` — the real `GetIrLights` reply carries these next to `value` even with `action: 0`.

- [ ] **Step 1: Failing test** — `factorySettings('Cam')` has exactly the key sets of the reference replies (compare `Object.keys` recursively against `reference/rlc-1224a/*.json` **when the folder exists**, `it.skipIf(!existsSync(...))`, so CI without the gitignored folder still passes); `devInfo('Cam','SIMABC',FIRMWARE.firmVer).serial === 'SIMABC'`; `ENC.mainStream.vType === 'h265'`; `ABILITY` has `rtsp`, `httpFlv`, `ftpSubStream`.

- [ ] **Step 2–4:** run (fail) → write the profile by transcribing the reference replies (the long `scope` / `area` bitmaps may be generated: `'1'.repeat(n)` with the measured length) → run (pass).

- [ ] **Step 5: Commit** `feat: RLC-1224A profile from measured replies`

---

### Task 4: Sessions and users

**Files:**
- Create: `src/engine/sessions.ts`
- Test: `test/sessions.test.ts`

**Interfaces:**
- Consumes: `Clock`, `User`, `createRng`.
- Produces: `class Sessions`:
  - `constructor(users: User[], clock: Clock, rng)`
  - `login(userName: string, password: string, ip: string): { ok: true; token: string; leaseTime: 3600 } | { ok: false; rspCode: -7 }`
  - `validate(token: string | undefined): SessionInfo | undefined` — expired leases (3600 s) are dropped here.
  - `logout(token: string): void`, `revokeAll(): void`, `revokeUser(name: string): void`
  - `online(): Array<{ canbeDisconn: 0; ip: string; level: string; sessionId: number; userName: string }>` — the `GetOnline` `User` list; `sessionId` increments from 10 per login (measured first id).
  - `users(): Array<{ level; userName }>`, `addUser(u: User): number | null` (rspCode on error: existing name → -27? **Ruling: `-4` "param error" for a duplicate or invalid user, the firmware's generic code; unverified**), `delUser(name): number | null`, `modifyUser(name, patch: { password?: string; level?: string }): number | null` — a password change calls `revokeUser`.
  - Tokens: 16 lowercase hex chars from `crypto.randomBytes` (not the seeded RNG).
  - Sessions accumulate: no cap (spec 7.1).

- [ ] **Step 1: Failing tests:** wrong password → `{ok:false,rspCode:-7}`; three logins without logout → `online().length === 3`; `fixedClock` advanced 3601 s → `validate` undefined and `online()` empty; `modifyUser('cams',{password:'n'})` → cams tokens invalid, admin tokens valid; `revokeAll`.
- [ ] **Step 2–4:** fail → implement (`Map<token, {user, ip, sessionId, expiresAt}>`) → pass.
- [ ] **Step 5: Commit** `feat: sessions and users`

---

### Task 5: Settings store

**Files:**
- Create: `src/engine/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `factorySettings`, `resetDefaults`, `Settings`.
- Produces: `class SettingsStore`:
  - `constructor(opts: { name: string; file?: string; log: pino.Logger })` — loads `file` if present; on parse error logs `settings_file_invalid` (warn) and starts from factory.
  - `running: Settings` (**mutable object**, exposed on purpose for in-process tests), `saved: Settings`
  - `get(key: keyof Settings, sub?: 'people' | 'vehicle' | 'dog_cat'): object` (deep copy)
  - `set(cmd: string, param: any, opts: { strictPartial: boolean }): { rspCode: number } | null` — `null` on success. Logic:
    1. `validate(cmd, param)` → rspCode or null (rules below).
    2. `saved[key] = replaceWith(resetDefaults()[key], sent)` — omitted keys at any depth take reset values.
    3. `running[key] = strictPartial ? saved[key] : deepMerge(running[key], sent)` — the camera shows the sent keys at once and keeps the rest until the next reboot.
    4. persist `saved` (atomic write: temp file with random suffix, `fsync`, rename — as cams' PREFS_FILE).
  - `applySavedOnReboot(): void` → `running = clone(saved)`.
  - `resetFactory(): void`.
  - Command map: `SetRecV20→Rec`, `SetMdAlarm→MdAlarm`, `SetAiAlarm→AiAlarm[param.AiAlarm.ai_type]`, `SetIsp→Isp`, `SetIrLights→IrLights`, `SetWhiteLed→WhiteLed`, `SetOsd→Osd`, `SetFtpV20→Ftp`, `SetNetPort→NetPort`.
  - Validation (from cams' mock `settingsError`, `test/mock-camera/server.ts:157-181`, plus measured): `sensDef` integer 1–50 else -56; AI `sensitivity` 0–100 else -56; `ai_type` ∉ {people, vehicle, dog_cat} → -67; `dayNight` ∉ {Auto, Color, Black&White} → -67; IrLights `state` ∉ {Auto, Off} → -67; WhiteLed `mode` ∉ 0–3 → -67, `bright` 0–100 else -56; OSD `pos` ∉ the 6 positions → -67, `name` > 31 UTF-8 bytes or containing `\p{C}` → -56; `SetFtpV20` with `Ftp.server === ''` → -4.
  - `merge`/`replaceWith` skip `__proto__`, `constructor`, `prototype` (CodeQL prototype-pollution finding in cams).

- [ ] **Step 1: Failing tests:**
  - partial `SetIsp {Isp:{channel:0,dayNight:'Color'}}` → `running.Isp.rotation === 0` (unchanged), `saved.Isp.rotation === 1`; after `applySavedOnReboot()` → `running.Isp.rotation === 1`.
  - same with `strictPartial: true` → `running.Isp.rotation === 1` at once.
  - whole-object write keeps everything.
  - each validation row → its rspCode, and state unchanged.
  - `{"__proto__":{"polluted":1}}` inside a Set → `({} as any).polluted === undefined`.
  - persistence: set, new store on same file → `saved` equal; truncated file → factory + warn log (Review Focus 5).
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat: settings with whole-object semantics`

---

### Task 6: SD card, recordings and events

**Files:**
- Create: `src/engine/sdcard.ts`, `src/engine/events.ts`
- Test: `test/sdcard.test.ts`, `test/events.test.ts`

**Interfaces:**
- Consumes: `Clock`, `localParts`, `isDstOn`, `SettingsStore`.
- Produces:
  - `type Trigger = 'motion' | 'person' | 'vehicle' | 'pet'`
  - `interface Recording { id: string; date: string; start: string; end: string | null /* null while recording */; mainEnd: string | null; triggers: Trigger[]; dst: boolean; files: { sub: { name: string; size: number }; main: { name: string; size: number } } }`
  - `flagsHex(stream: 'sub'|'main', triggers: Trigger[]): string` — base `0x55148000000000n` (sub), `0x7b288200000000n` (main); bit `55 − pos` with pos person 17, vehicle 19, pet 20, motion 24 (cams mock lines 198-205).
  - `fileName(stream, date, dst, start, end /* '000000' while recording */, triggers, size): string` → `/mnt/sda/Mp4Record/<date>/Rec<S|M>0A_<DST?><YYYYMMDD>_<start>_<end>_0_<flags>_<SIZEHEX>.mp4`
  - `class SdCard`:
    - `constructor(opts: { dir?: string; capacityMb: number; clock; tz; log; fixtureSizes: { sub: number; main: number } })` — index in `<dir>/index.json` (same atomic write; corrupt → empty + warn).
    - `add(rec: Omit<Recording,'id'|'files'>): Recording`, `finish(id, end: string, mainEnd: string)`, `extend(id, triggers: Trigger[])`
    - `search(stream: 'sub'|'main', from: Date-ish {year,mon,day}, to): Array<{ name; size: string; type: stream; StartTime; EndTime; frameRate: 0; width: 0; height: 0 }>` — `StartTime`/`EndTime` objects `{year,mon,day,hour,min,sec}`; while recording, the name's end is `000000` and `EndTime` equals `StartTime`.
    - `status(stream, year, mon): { year; mon; table: string }` — one char per day of the month.
    - `byName(name: string): { rec: Recording; stream } | undefined` — exact match only.
    - `hddInfo(): [{ capacity; format: 1; mount: 1; number: 0; size /* MB free */; storageType: 2 }]`
    - `retention(saveDay: number): void` — deletes days older than `saveDay` and the oldest days while used > capacity.
    - `type SeedClip = { daysAgo: number; start: string; end: string; triggers: Trigger[]; mainEnd?: string }`; `seed(clips: SeedClip[]): void` and `DEMO_CLIPS: SeedClip[]` (the six clips of cams' `DEFAULT_MOCK_CLIPS`).
    - `clear()`
  - `class Events`:
    - `constructor({ clock, sd: SdCard, settings: SettingsStore, timers?: { setTimeout, clearTimeout } , postRecS: () => number })`
    - `trigger(type: Trigger, durationS: number): { recording: Recording | null }` — AI types also set motion; recorded only when `Rec.enable === 1` and the schedule table for the type (`MD`, `AI_PEOPLE`, `AI_VEHICLE`, `AI_DOG_CAT`) has `1` at index `weekday*24 + hour` (Sunday = 0; **ruling: weekday indexing unverified on the camera**). An event during an active recording extends it (`extend`) instead of adding a second one when it starts within the post-record window (**ruling: the firmware sometimes makes overlapping clips instead; not modelled in Plan 1**).
    - Recording ends at `duration + postRec` (`'15 Seconds'` → 15, `'1 Minute'` → 60, …); main ends 2 s after sub (measured example 065224 vs 065226).
    - `mdState(): { state: 0|1 }`, `aiState(): the GetAiState value` (shape from reference; `face.support: 0`).
    - `recent(limit)`.
    - `startAuto(spec: string)` / `stopAuto()` — `CAMSIM_AUTO_EVENTS` (`motion:6/h,person:1/h`): per type, exponential (Poisson) intervals from the seeded RNG, duration 3–20 s; invalid spec → `ConfigError` at load time (parse in `config.ts`, `autoEvents: Array<{ type: Trigger; perHour: number }>` added to `CamSimConfig`).

- [ ] **Step 1: Failing tests** (fixed clock):
  - `flagsHex('sub',['motion']) === '55148080000000'`, `flagsHex('sub',['person','vehicle','motion']) === '5514D080000000'`, `flagsHex('main',['motion']) === '7B288280000000'`.
  - trigger motion 5 s at 06:52:21 CDT with `postRec` 15 s → Search while running shows `…_065221_000000_…`; after 20 s (fake timers) sub end `065241`, main end `065243`, name has `DST20260926`.
  - Review Focus 3: event at 23:59:50 local → date is the start date; clip on `2026-11-01` → no `DST` marker; `2026-03-08` → marker.
  - `Rec.enable 0` → no recording; schedule `AI_PEOPLE` all `0` → a person event records only as motion if `MD` allows (**ruling**: the recording's triggers are only the scheduled ones).
  - Search: no clips → `File` absent (Task 8 renders that; here: empty array); `status` table.
  - retention: capacity 1 MB with fixture sizes 700 KB → the oldest recording goes.
  - `seed(DEMO_CLIPS)` → 4 today, 2 yesterday.
  - corrupt `index.json` → empty + warn.
  - `byName('/mnt/sda/Mp4Record/../../etc/passwd') === undefined` (Review Focus 1).
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat: SD card, recordings and events`

---

### Task 7: Faults and counters

**Files:**
- Create: `src/engine/faults.ts` (replace the Task 2 stub), `src/engine/counters.ts`
- Test: `test/faults.test.ts`

**Interfaces:**
- Produces:
  - `type FaultName = 'downloads.refuse' | 'downloads.dropFirst' | 'downloads.dropMidway' | 'downloads.delayMs' | 'flv.reset' | 'flv.delayMs' | 'search.delayMs' | 'settings.fail' | 'settings.ignore' | 'settings.strictPartial' | 'offline' | 'latencyMs' | 'snap.fail'`
  - Actions (not persistent faults, applied once): `'flv.dropActive' | 'downloads.dropActive' | 'tokens.revoke' | 'reboot'`
  - `interface FaultSpec { name: FaultName; count?: number /* next N matching requests, then off */; ms?: number; cmds?: string[]; rspCode?: number }`
  - `class Faults extends EventEmitter`: `set(spec)`, `clear(name)`, `clearAll()`, `list(): FaultSpec[]`, `active(name): FaultSpec | undefined`, `consume(name): FaultSpec | undefined` (decrements `count`, clears at 0, emits `change`).
  - `settings.fail` default `rspCode: -67`; `downloads.dropFirst` requires `count`.
  - `class Counters` with the fields of spec section 9 (`logins, loginAttempts, activeSessions (computed), devInfoCalls, activeStreams, streamsOpened, downloads, activeDownloads, droppedDownloads, downloadOrder: string[], searches, setCalls: string[], reboots`) and `reset()`.
  - Mock-option mapping table (documented in `README.md`, used by cams' adapter in Task 16): `flvDelayMs→flv.delayMs`, `downloadDelayMs→downloads.delayMs`, `searchDelayMs→search.delayMs`, `dropFirstDownloads→downloads.dropFirst{count}`, `settingsFailures→settings.fail{cmds}`, `ignoreWrites→settings.ignore{cmds}`, `rebootMs/rebootDropsConnection→reboot action params`, `offline→offline`, `rejectAllStreams→flv.reset`, `revokeTokens()→tokens.revoke`, `dropStreams()→flv.dropActive`, `dropDownloads()→downloads.dropActive`; partial-write-visible-at-once → `settings.strictPartial`.
- [ ] **Step 1: Failing tests:** `set({name:'downloads.dropFirst',count:2})`, `consume` ×3 → spec, spec, undefined; unknown name → throws; `list()` after `clearAll()` empty; `change` events emitted.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat: faults and counters`

---

### Task 8: Fixture media and FLV

**Files:**
- Create: `src/media/flv.ts`, `src/media/source.ts`, `src/media/fixtures.ts`
- Test: `test/flv.test.ts`, `test/fixtures.test.ts`

**Interfaces:**
- Produces:
  - `readFlv(buf: Buffer): { header: Buffer; tags: Array<{ type: 8 | 9 | 18; ms: number; codecId?: number; bytes: Buffer }> }` (header incl. PreviousTagSize0; `bytes` incl. trailing PreviousTagSize, as cams' mock `liveFixture()`).
  - `class FlvWriter { header(hasAudio: boolean, hasVideo: boolean): Buffer; videoConfig(codec: 'h264'|'h265', record: Buffer, ms: number): Buffer; video(codec, nalus: Buffer[], keyframe: boolean, ms: number, ctsMs?: number): Buffer; audioConfig(asc: Buffer, ms): Buffer; audio(raw: Buffer, ms): Buffer }` — video tag body: `(frameType<<4)|codecId`, `AVCPacketType` (0 config, 1 NALU), 24-bit CTS, then length-prefixed NALUs (4-byte). **H.265 uses codec id 12 with the same layout** and an `HEVCDecoderConfigurationRecord` built by `hvcc(vps, sps, pps): Buffer`.
  - `splitAnnexB(buf: Buffer): Buffer[]`, `h265NalType(nalu) = (nalu[0] >> 1) & 0x3f` (VPS 32, SPS 33, PPS 34, IDR 19/20, CRA 21).
  - `interface MediaSource { snapshot(): Promise<Buffer>; liveFlv(stream: 'sub'|'main'): { header: Buffer; tags: FlvTag[] }; clipPath(stream: 'sub'|'main'): string; clipSize(stream): number }`
  - `ensureFixtures(dir: string, log): Promise<FixturePaths>` — if all files exist and `manifest.json` matches `FIXTURE_VERSION`, returns; otherwise runs ffmpeg (`execFile`, no shell) to create in `dir`:
    - `snapshot.jpg`: `testsrc2=size=896x512`, one frame, with `drawtext` of "cam-sim" omitted (no fonts in slim images) — plain pattern;
    - `sub.flv`: 6 s, `testsrc2=size=896x512:rate=10` + `sine=frequency=440`, `libx264 -profile:v high -g 20`, `aac`, `-f flv`;
    - `main.h265` + `main.aac` (6 s, `testsrc2=size=1280x720:rate=20` — **ruling: fixtures use 1280×720 for main instead of 4512×2512 to keep generation under a few seconds; `GetEnc` still reports the real sizes**; `libx265 -x265-params keyint=40`, Annex B) → composed into `main.flv` with `FlvWriter` codec id 12;
    - `clip-sub.mp4`, `clip-main.mp4`: 4 s each, `-movflags frag_keyframe+empty_moov+default_base_moof -brand mp42` (so Download starts with `ftyp mp42`, like the firmware's remux);
    - `manifest.json` `{version, sizes}`.
    - Default dir: `CAMSIM_FIXTURE_DIR` ?? `<os.tmpdir()>/cam-sim-fixtures-<FIXTURE_VERSION>`; generation guarded by a lock file so parallel vitest workers generate once.
  - `class FixtureMedia implements MediaSource` built from `FixturePaths`.
- [ ] **Step 1: Failing tests:**
  - `FlvWriter` round trip: write header + H.265 config + one keyframe → `readFlv` shows tag type 9, `codecId === 12`, first body byte `0x1C`, AVCPacketType 0 then 1.
  - `hvcc()` from a tiny synthetic VPS/SPS/PPS → `configurationVersion === 1`, array count 3 with NAL types 32/33/34.
  - `ensureFixtures(tmp)` (skipped if `ffmpeg` missing locally, **required in CI**) → files exist; `clip-sub.mp4` bytes 4–11 are `ftypmp42`; `readFlv(sub.flv)` first video tag codec id 7; `main.flv` codec id 12; second call does not re-run ffmpeg (mtime unchanged).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat: fixture media and FLV writer (codec id 12)`

---

### Task 9: Engine composition and the camera API

**Files:**
- Create: `src/engine/engine.ts`, `src/camera-api/app.ts`, `src/camera-api/commands.ts`, `src/camera-api/media-routes.ts`
- Test: `test/conformance/*.test.ts` (one file per area: session, device, settings, search, download, snap, flv, reboot, users, netport), using `supertest` against the Express app in-process.

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `class Engine { config; clock; rng; log; sessions; settings; sd; events; faults; counters; media: MediaSource; serial: string; offline(): boolean; reboot(opts?: { ms?: number; dropsConnection?: boolean }): Promise<void>; certificate: CertState /* Task 10 */; searchBusy: boolean; downloadBusy: boolean; bus: EventEmitter /* 'request' | 'event' | 'state' */ }` and `createEngine(config, deps?: { clock?; media?; log? }): Promise<Engine>`.
  - `createCameraApp(engine: Engine, opts: { port: 'http' | 'https' }): express.Express`.
- Behaviour (each bullet = at least one conformance test):
  - `speed: 'real'` adds the measured timings: Login ~200 ms, Search ~300 ms, Download throttle 150 KB/s, reboot 60 s. `fast`: none of these, reboot 1 s.
  - Middleware order: (1) `offline` fault or rebooting → `req.socket.destroy()`; (2) `latencyMs`; (3) NetPort: on the HTTP app, `httpEnable 0` → destroy; on HTTPS, `httpsEnable 0` → destroy; (4) body parser `express.json({ type: () => true, limit: '1mb' })` (the camera accepts any content type); (5) request log hook (Task 11).
  - `POST /cgi-bin/api.cgi?cmd=X[&token=T]`: body array; reply array; **`res.type('text/html')`** on every JSON reply.
    - `Login` → `{Token:{leaseTime:3600,name}}`; wrong password `{code:1,error:{detail:'login failed',rspCode:-7}}`; counts `loginAttempts`/`logins`.
    - no/invalid token → `-6` "please login first".
    - `Logout`, `GetOnline`, `GetUser` (`{CurUser:{User:<name>}, User:[{level,userName}]}`), `AddUser`, `DelUser`, `ModifyUser`.
    - `GetDevInfo` (counts `devInfoCalls`), `GetTime`, `GetHddInfo`, `GetEnc`, `GetNetPort`, `GetAbility`.
    - Get/Set settings per Task 5; `settings.fail` / `settings.ignore` faults apply before the store; every Set appends to `counters.setCalls`; `GetIrLights` reply includes `initial` and `range`.
    - `GetMdState`, `GetAiState` from `Events`.
    - `Search`: `engine.searchBusy` device-wide: a second Search while busy → `-54` "the respode of msg is err" **and marks the in-flight one to return no `File`** (Review Focus 4); duration `search.delayMs` fault ?? 20 ms (fast) / 300 ms (real). `onlyStatus:1` → `{SearchResult:{channel:0,Status:[{year,mon,table}]}}`; else `{SearchResult:{channel:0, File?}}` with `File` omitted when empty.
    - `CheckDownload {filename}` → `{downloadTask: downloadBusy ? 1 : 0}` when the name (full path or basename) exists, else `-4` "param error" (measured for an unknown name).
    - `Reboot` → counts; 50/50 (seeded) answer-then-offline or destroy; offline `rebootMs` (fast 1000, real 60000; `reboot` action params override); on return: new serial `SIM` + 12 hex, `sessions.revokeAll()`, `settings.applySavedOnReboot()`.
    - anything else → `{"cmd":"Unknown","code":1,"error":{"detail":"not support","rspCode":-9}}`, including `GetFtp`, `TestFtpV20`, `TestFtp` (Plan 6), `CheckFirmware` (**ruling: reply shape not captured; -9 until captured**).
  - `GET /cgi-bin/api.cgi?cmd=Snap|Download|download|Playback`:
    - `Download`/`download`: raw query `source=` containing `%2F` (any case) → destroy; invalid token → 401 `text/html` empty; `user=`/`password=` params instead of a token → 404 `text/html`; `downloads.refuse` or `downloads.dropFirst` (consumed) or `httpEnable 0` → destroy and `droppedDownloads++`; unknown or traversal source → destroy (Review Focus 1); `downloadBusy` → destroy (one at a time, device-wide); else `200 video/mp4` streaming the fixture clip for that stream (`/RecM` → main), `downloads.delayMs` before the body, `real` speed throttles to 150 KB/s, `downloads.dropMidway` destroys after half the bytes; `downloadOrder.push(start)`; `downloads.dropActive` action destroys active responses.
    - `Playback` → 404.
    - `Snap`: invalid token → 200 `text/html` body `[{"code":1,"error":{"rspCode":-6,"detail":"please login first"}}]`; `snap.fail` → 500; else `image/jpeg` from `media.snapshot()`.
  - `GET /flv?port=1935&app=bcs&stream=channel0_<main|sub>.bcs&token=T`: invalid token, `flv.reset`, or `rtmpEnable 0` → destroy; `flv.delayMs`; else `200 video/x-flv`, header then tags paced by timestamp (20 ms interval, as cams' mock `app.get('/flv')`), then **loop the fixture with timestamps offset by the fixture duration** (the camera never ends a stream; this is stricter than cams' mock, which stopped after one pass); counts `activeStreams`/`streamsOpened`; `flv.dropActive` destroys all.
- [ ] **Step 1:** write the conformance tests (one `describe` per bullet group above; token helper `login(app)`; fixture dir from `ensureFixtures` in a vitest `globalSetup`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement `engine.ts`, `commands.ts` (a `Record<string, Handler>` with `Object.hasOwn` lookup — never `obj[cmd]()` on untrusted `cmd`, per the CodeQL finding in cams), `media-routes.ts`, `app.ts`.
- [ ] **Step 4:** run → PASS. **Step 5: Commit** `feat: Reolink-compatible camera API`

---

### Task 10: Listeners, TLS and certificates

**Files:**
- Create: `src/tls/certs.ts`, `src/camera-api/listeners.ts`
- Modify: `src/engine/engine.ts` (certificate state), `src/camera-api/commands.ts` (`GetCertificateInfo`, `CertificateClear`, `ImportCertificate`)
- Test: `test/tls.test.ts`

**Interfaces:**
- Produces:
  - `type CertState = { source: 'factory' | 'imported' | 'env'; cert: string; key: string; enable: 0 | 1 }`
  - `loadInitialCert(config, dataDir): CertState` — env files → `env` (enable 1); else `<data>/cert/server.{crt,key}` → `imported` (enable 1); else factory self-signed `CN=CERTIFICATE`, RSA 2048, generated with `selfsigned` and stored in `<data>/cert/factory.*` so it survives restarts (enable 0).
  - `startListeners(engine, apps): Promise<{ http: Server; https: Server; close(): Promise<void> }>` — HTTPS via `https.createServer` with `SNICallback`/`setSecureContext` so a new certificate applies without restarting the server.
  - Commands: `GetCertificateInfo` → `{CertificateInfo:{crtName:'server.crt',enable,keyName:'server.key'}}`; `CertificateClear` → factory cert, `enable 0`, all tokens revoked, camera ports offline for `certRestartMs` (fast 200, real 10000); `ImportCertificate {importCertificate:{crt:{size,name,content},key:{…}}}` — base64 PEM; when `enable === 1` → `rspCode 200`, nothing changes (measured quirk); else validate with `crypto.createPrivateKey` / `X509Certificate` and matching key (`checkPrivateKey`), invalid → `-4`; valid → store in `<data>/cert/`, `enable 1`, same restart as Clear.
- [ ] **Step 1: Failing tests:** start listeners on port 0; TLS handshake presents `CN=CERTIFICATE`; import over an enabled cert changes nothing; Clear → import → the handshake presents the imported cert (generate a test cert with `selfsigned` for `cam2.skylar.technology`); `httpsEnable 0` via `SetNetPort` → HTTPS connections reset, HTTP still answers.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat: TLS listeners and certificate import`

---

### Task 11: Control API, SSE, request log

**Files:**
- Create: `src/control-api/app.ts`, `src/control-api/sse.ts`, `src/control-api/request-log.ts`, `openapi.yaml`
- Test: `test/control-api.test.ts`, `test/openapi.test.ts`, `test/redaction.test.ts`

**Interfaces:**
- Produces: `createControlApp(engine): express.Express` with routes of spec section 9 minus `/sim/api/videos` and `PUT /sim/api/video` (Plan 2; they answer 501 `{error:'not_in_this_version'}` for now) — `GET /sim/api/state`, `POST/GET /sim/api/events`, `POST /sim/api/recordings/seed`, `DELETE /sim/api/recordings`, `GET/PUT/DELETE /sim/api/faults[/<name>]`, `POST /sim/api/actions/<tokens.revoke|reboot|flv.dropActive|downloads.dropActive>` (**ruling: one-shot actions get their own route instead of pretending to be faults**), `POST /sim/api/reset`, `GET /sim/api/requests`, `GET /sim/api/stream`, `GET /healthz`.
  - Auth middleware: `Authorization: Bearer x`, `crypto.timingSafeEqual` on SHA-256 digests (equal length); missing/wrong → 401 `{error:'unauthorized'}`; `?token=` / `?access_token=` present → 400 `{error:'token_in_url'}`; no token configured → every `/sim/api/*` 404.
  - `RequestLog` ring buffer (500): `{ at, port: 'http'|'https', method, path, cmd, status, ms }` — `path` never includes the query string.
  - SSE: `event: state|event|request|fault`, `id:` monotonically increasing, heartbeat comment every 15 s.
  - `/sim/api/state` → `{ name, serial, model, firmVer, offline, rebooting, faults, events: recent(20), sd: {usedMb, capacityMb, recordings}, counters, settings: running }`.
  - `openapi.yaml` (OpenAPI 3.1) describes every route; `test/openapi.test.ts` compares its `paths` with the Express router's registered routes.
- [ ] **Step 1: Failing tests:** auth cases (Review Focus 2 incl. 400 on `?token=`); trigger event → Search shows it; fault PUT/DELETE; `reset {counters:true}`; SSE receives an `event` after a trigger (read the stream with `fetch` + reader, abort after first event); `test/redaction.test.ts`: Login with password `S3cret-pw` and a Snap with a token through the camera app with a memory log stream → neither the password nor the token in log output nor in `/sim/api/requests` JSON.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat: control API with bearer auth and SSE`

---

### Task 12: `createCamSim` and the CLI

**Files:**
- Modify: `src/index.ts`
- Create: `src/cli.ts`
- Test: `test/index.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CamSimOptions {
    users: User[];                       // required
    name?: string; controlToken?: string; tz?: string; sdMb?: number;
    speed?: 'fast' | 'real'; firmVer?: string; seed?: number;
    dataDir?: string;                    // omit → in-memory (no persistence)
    faults?: FaultSpec[]; seedClips?: 'demo' | SeedClip[];
    clock?: Clock; fixtureDir?: string; logLevel?: string;
  }
  export interface CamSim {
    engine: Engine;
    cameraApp: express.Express;          // HTTP-port app (for supertest)
    controlApp: express.Express;
    listen(ports?: Partial<{ http: number; https: number; control: number }>): Promise<{ http: number; https: number; control: number }>;
    close(): Promise<void>;
  }
  export function createCamSim(opts: CamSimOptions): Promise<CamSim>;
  export { DEMO_CLIPS, type FaultSpec, type SeedClip, type Trigger };
  ```
  - `dataDir` omitted → nothing is written to disk (settings, SD index, certs in memory).
  - The control listener uses TLS with the camera's current certificate when `tlsCertFile` is configured (spec section 4), plain HTTP otherwise.
  - `autoEvents` from config start `events.startAuto` after `listen`.
  - `cli.ts`: `loadConfig(process.env)` → `createCamSim` → `listen(config.ports)`; logs `cam_sim_listening` with ports (no secrets); `SIGTERM`/`SIGINT` → `close()`; config errors → exit 2 with the message.
- [ ] **Step 1: Failing tests:** `createCamSim({users:[…]})` → `supertest(sim.cameraApp)` Login works; `listen({http:0,https:0,control:0})` returns real ports; `close()` releases them; `sim.engine.settings.running.Rec.enable = 0` is visible through `GetRecV20` (cams' tests mutate state directly); CLI spawned with `tsx` and env → `/healthz` 200, SIGTERM → exit 0; missing `CAMSIM_USERS` → exit 2, stderr names the variable.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat: in-process API and CLI`

---

### Task 13: Container

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `scripts/container-smoke.sh`
- Modify: `README.md` (run instructions)

- [ ] **Step 1: Dockerfile** — two stages on `node:26-alpine` like cams: builder (`npm ci`, `npm run build`); runtime: `apk add --no-cache ffmpeg`, `npm ci --omit=dev`, `COPY dist`, `ENV CAMSIM_DATA_DIR=/data CAMSIM_FIXTURE_DIR=/opt/cam-sim/fixtures`, **generate fixtures at build time** (`RUN node dist/src/cli.js --make-fixtures` — add that flag to `cli.ts`: runs `ensureFixtures` and exits), `mkdir /data && chown 1000:1000`, `USER 1000:1000`, `EXPOSE 8443 8080 9443`, `HEALTHCHECK` with `wget -qO- http://127.0.0.1:9443/healthz` (control port serves plain HTTP when no TLS cert is configured; with a cert, `--no-check-certificate https://…`), `CMD ["node","dist/src/cli.js"]`. ARGs `APP_VERSION`, `BUILD_DATE` after the dependency layers (cams comment explains why).
- [ ] **Step 2: compose.yaml** — services `cam2`, `cam3`, `cam4` from the local build, each with its own named volume, `CAMSIM_NAME`, ports `8443+n`, `8080+n`, `9443+n` published on `127.0.0.1`, `env_file: .env` for `CAMSIM_USERS` and `CAMSIM_CONTROL_TOKEN`, `CAMSIM_SEED_CLIPS: demo`.
- [ ] **Step 3: scripts/container-smoke.sh** — builds the image, runs it with throwaway `CAMSIM_USERS`/`CAMSIM_CONTROL_TOKEN` generated by `openssl rand` (never echoed), waits for health, then with curl: Login over HTTPS (`-k`), `GetDevInfo`, read 2 s of `/flv` sub (check `FLV` magic), trigger a motion event via the control API, Search today finds it, Download it and check `ftypmp42`, stop the container. Exit non-zero on any failure.
- [ ] **Step 4: Run** `scripts/container-smoke.sh` locally → PASS. `docker buildx build --platform linux/amd64,linux/arm64 .` → builds.
- [ ] **Step 5: CI** add job `container` to `pr-checks.yml` running the smoke script. **Commit** `feat: container image and smoke test`

---

### Task 14: Secrets: `.env.example` and `sync-secrets.sh`

**Files:**
- Create: `.env.example`, `scripts/sync-secrets.sh`
- Test: `test/sync-secrets.test.ts` (runs the script with `--dry-run` and stubbed `gh`/`kubectl` on `PATH`)

- [ ] **Step 1: .env.example**

```sh
# cam-sim secrets for the cluster deployment. Copy to .env (mode 600); values are
# generated by scripts/sync-secrets.sh when empty. Never commit .env.
CAMSIM_CONTROL_TOKEN=
# Camera users of cam2, name:level:password; the password part is generated when empty.
CAMSIM_USERS=admin:admin:;cams:admin:
KUBE_CONTEXT=
KUBE_NAMESPACE=cam-sim
KUBE_SECRET=cam-sim-secrets
GITHUB_REPO=klaushofrichter/cam-sim
```

- [ ] **Step 2: sync-secrets.sh** (bash, `set -euo pipefail`, `umask 077`):
  1. Refuse to run if `.env` is missing (copy hint), or group/world-readable (`chmod 600` hint).
  2. Fill empty values: `CAMSIM_CONTROL_TOKEN` ← `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`; each empty password in `CAMSIM_USERS` ← 24 chars from `openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24`. Rewrite `.env` in place via a temp file in the same directory, `mv`. Never print values.
  3. `--dry-run`: print which keys would be generated and which targets would be written; change nothing.
  4. GitHub: for `CAMSIM_CONTROL_TOKEN` and `CAMSIM_USERS`: `printf %s "$v" | gh secret set NAME --repo "$GITHUB_REPO"` (value on stdin, not argv).
  5. Kubernetes: build an env file with only the `CAMSIM_*` keys in a `mktemp` file (deleted by `trap`), then `kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" create secret generic "$KUBE_SECRET" --from-env-file=… --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -`. Require `KUBE_CONTEXT` set (no default context).
  6. `--rotate KEY`: blank that key (or one user's password with `--rotate CAMSIM_USERS:cams`), then continue as normal.
  7. `--only github|kube`. Output: names only, e.g. `set github secret CAMSIM_CONTROL_TOKEN`.
- [ ] **Step 3: Test** with stub `gh` and `kubectl` scripts that record their argv and stdin to files: after a run, `.env` has non-empty values, the stubs received them on stdin/file (never in argv), stdout contains no value; `--dry-run` leaves `.env` byte-identical.
- [ ] **Step 4: Commit** `feat: secrets sync script`. (Klaus runs it for real; the agent never does.)

---

### Task 15: Build and release workflow

**Files:**
- Create: `.github/workflows/build-push.yml`, `.github/workflows/release.yml`

- [ ] **Step 1:** `build-push.yml` on push to `main`: buildx multi-arch, push `ghcr.io/klaushofrichter/cam-sim:main` and `:sha-<short>`; `permissions: contents: read, packages: write`. The image contains only generated test-pattern fixtures (no camera content).
- [ ] **Step 2:** `release.yml` on push to `production` (same flow as cams' `deploy-production.yml` minus the deploy): calendar version `vYYYY.MM.DD.N`, tag, GitHub release with the CHANGELOG section, image tags `:vYYYY.MM.DD.N` and `:latest`. **No release assets.**
- [ ] **Step 3: Commit** `ci: image build and release`

---

### Task 16: cams compatibility (acceptance)

**Files (cam-sim):**
- Create: `.github/workflows/cams-compat.yml`
**Files (cams, branch `test/cam-sim`):**
- Create: `test/camera/sim.ts` (adapter), `e2e/sims.ts` (Playwright camera startup)
- Modify: the 5 unit test files and 3 e2e files listed below, `playwright.config.ts`, `package.json` (devDependency `"cam-sim": "github:klaushofrichter/cam-sim#<tag>"`)
- Delete (only after the suites pass): `test/mock-camera/`, `test/mockCamera.test.ts` (its cases now live in cam-sim's conformance tests)

**Interfaces:**
- `test/camera/sim.ts` exports `createMockCamera(opts: MockCameraOptions): Promise<{ app; state }>` with the **same option names and `state` fields** as the old mock, implemented on `createCamSim` via the Task 7 mapping; `state` is an object of getters/setters (`state.offline = true` → `faults.set({name:'offline'})`; `state.settings` → `engine.settings.running`; `state.revokeTokens()` → `sessions.revokeAll()`, …). Options `model`/`firmware` map to `firmVer` (cams tests expect `v3.2.0.6011_mock`), and the adapter sets `settings.strictPartial` (the old mock showed partial-write resets at once).
  - `createMockCamera` becomes async: the only other change in the test files is `await` at the call sites (provisioning, allowed by spec section 16).
- Unit files: `test/cameraRoutes.test.ts`, `test/reolinkClient.test.ts`, `test/settingsRoutes.test.ts`, `test/recordingsRoutes.test.ts` → import from `./camera/sim`.
- e2e: `playwright.config.ts` `webServer` entries run `npx cam-sim` (from the git dependency) on 8098/8097/8096 with `CAMSIM_HTTP_PORT`, `CAMSIM_USERS=e2e:admin:e2e-not-a-real-password`, `CAMSIM_SEED_CLIPS=demo`, `CAMSIM_CONTROL_TOKEN=e2e-control`, and `CAMSIM_FAULTS` (Porch: `[{"name":"settings.fail","cmds":["SetWhiteLed"]}]`; Shed: `[{"name":"downloads.refuse"}]`); `e2e/live-teardown.spec.ts`, `e2e/live-keepalive.spec.ts`, `e2e/settings.spec.ts` read `/sim/api/state` on the control port with the bearer header instead of `/__state`. (**Ruling: e2e runs cam-sim as a process from the git dependency, not as a container; the container is covered by cam-sim's own smoke test. Spec section 12 wording is updated accordingly.**)
- Mock behaviours the firmware doesn't have → fix the cams test with a comment, never copy into cam-sim. Known candidate: two e2e camera ids sharing one mock (`searching` keyed by token); with cam-sim each id gets its own simulator.
- `cams-compat.yml` in cam-sim (on PR and nightly): checks out `klaushofrichter/cams` at `main` (or `test/cam-sim` until merged, via input), replaces the `cam-sim` dependency with the PR's checkout (`npm i ../cam-sim`), runs `npm test` and `npm run build && npm run test:e2e`.
- [ ] **Step 1:** tag cam-sim `v2026.MM.DD.1` (after Tasks 1–15 are merged) so cams can pin it.
- [ ] **Step 2:** cams branch: adapter + imports + config. Run `npm test` and `npm run test:e2e` → fix failures in cam-sim (firmware-faithful) or in cams tests (mock-only behaviour), noting each in `docs/superpowers/plans/2026-09-26-cam-sim-1-compat-notes.md` in cam-sim.
- [ ] **Step 3:** both suites green → delete cams' `test/mock-camera/` and `test/mockCamera.test.ts`; update cams `docs/reolink-api.md` ("change the mock camera" → "change cam-sim") and its CLAUDE.md if it mentions the mock.
- [ ] **Step 4:** cams PR (CI green) → merge per the cams flow; cam-sim `cams-compat.yml` switched to `main`.
- [ ] **Step 5: Commit** (each repo) and record completion in both CHANGELOGs.

---

### Task 17: Ship Plan 1

- [ ] Full gate in cam-sim: `npm test` twice (flakiness), `npm run build`, `npm run lint:types`, `scripts/container-smoke.sh`, `git ls-files` media check.
- [ ] Final whole-branch review (most capable model).
- [ ] PR to `main`, merge when green; PR `main` → `production` → release `vYYYY.MM.DD.1`.
- [ ] Update the spec: section 12 (process instead of container in cams e2e), section 17 (phase 1 done).
- [ ] Tell Klaus: `reference/` awaits his review; he can run `scripts/sync-secrets.sh` once `.env` exists.
