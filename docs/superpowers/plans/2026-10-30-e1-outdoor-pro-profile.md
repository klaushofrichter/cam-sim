# E1 Outdoor Pro Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `CAMSIM_MODEL=E1-Outdoor-Pro` makes cam-sim answer as the Reolink E1 Outdoor Pro, a pan/tilt/zoom camera. It keeps a virtual pan/tilt/zoom/focus state and 64 preset slots, draws the position on the picture, and lets tests read it over the control API. cam-proxy (plan B) and cams can then be built and tested against it.

**Architecture:**
- A new pure module `src/engine/ptz.ts` (class `Ptz`) holds the virtual state. It advances moves lazily from the engine's `Clock`, so a `fixedClock` makes every test deterministic.
- The engine owns one `Ptz` per simulator, and only when the profile's ability has `ptzCtrl.permit > 0`. Otherwise `engine.ptz` is `null`.
- The PTZ command handlers live in `src/camera-api/ptz-commands.ts`. `runCommand()` consults them only when `engine.ptz` is set. The fixed models (RLC-1224A, CX820) never reach them and answer exactly as today.
- The profile `src/profile/E1-Outdoor-Pro.ts` is built from the sanitized captures in `reference/E1-Outdoor-Pro/`.
- Picture: an extra centered `drawtext` in the SD pipeline's filter chain, plus a one-frame ffmpeg overlay on snapshots for PTZ profiles.

**Tech Stack:** Node, TypeScript (strict), Express 5, Vitest, supertest, ffmpeg (already required). No new dependency.

**Spec:** cam-proxy's `docs/superpowers/specs/2026-10-30-ptz-capabilities-design.md` (cam-proxy worktree `/Volumes/SSD-WDBlack-1T/claude-work/cp-ptz`). This plan covers §8.1 and cam-sim's part of §8.3; §3 has the measured facts. Plan A of four (A cam-sim, B cam-proxy, C cams, D cams-admin/move).

## Global Constraints

- Model id is exactly `E1-Outdoor-Pro`. The existing ids `RLC-1224A` (default) and `CX820` are unchanged; matching stays case-sensitive (`oneOf`).
- RLC-1224A and CX820 answer byte for byte as today: PTZ commands give `{cmd:'Unknown',code:1,error:{detail:'not support',rspCode:-9}}`, Snap returns the fixture JPEG, and the SD filter chain is unchanged.
- The repo is public. `reference/` and `src/profile/` hold no real serial (use `SIM000000000000`), MAC, UID, token, password, or real camera name (use `Cam`). The only IP addresses allowed are `192.0.2.0/24`.
- Measured values (spec §3), copied verbatim:
  - speed 1–64; speed may be left out; 0 or above 64 → `-4` "param error"; an unknown op → `-4`.
  - zoom 0–27, focus 0–97 (initial zoom 7, focus 49).
  - preset ids 0–63 (64 → `-4`), names up to 31 characters; a longer name is stored as `pos<id+1>`.
  - `ToPos` to an empty slot → 200 with no move.
  - `GetPtzCurPos` → `{code:1,error:{detail:"not exist",rspCode:-1}}`.
- The ops are `Left Right Up Down LeftUp LeftDown RightUp RightDown Stop ZoomInc ZoomDec FocusInc FocusDec ToPos`.
- Behave like the real camera. Anything this plan decides without a measurement carries a `(not measured)` comment in the code and a line in `reference/E1-Outdoor-Pro/README.md`.
- Faults are a contract: a change to what a fault covers updates the README fault table and CHANGELOG together.
- User-visible changes go under `## Unreleased` in CHANGELOG.md. Never put a version in the sources.
- Each task ends green on `npm test` and `npm run lint:types`. Commit messages end with the two attribution lines from the session.

## Review Focus

1. **A move that runs into the end stop without a `Stop`:** pan/tilt/zoom/focus clamp at their limits and never go NaN or out of range; `GetZoomFocus` stays within 0–27 / 0–97. (Task 2)
2. **A new move while one is running** (cam-proxy's lease replaces moves without a Stop in between): the old move is settled at the switch time, so there is no jump and no double counting. (Task 2)
3. **Reboot, power cycle or reset mid-move:** reboot and power-on stop the move but keep the presets; `POST /sim/api/reset` and factory reset clear both. (Task 4, Task 6)
4. **A fixed model receiving PTZ commands** (cams or cam-proxy probing every camera): unchanged `-9`; `GET /sim/api/ptz` → 404; Snap bytes unchanged. (Task 4, Task 6, Task 7)
5. **Several in-process simulators** (cam-proxy runs many in one test process): the PTZ state lives in each engine, never in a module, so two E1 sims move independently. (Task 4)

---

### Task 1: Reference captures for the E1 Outdoor Pro

**Files:**
- Create: `reference/E1-Outdoor-Pro/*.json` and `reference/E1-Outdoor-Pro/README.md`
- Test: `test/reference-privacy.test.ts`

**Interfaces:**
- Produces: `reference/E1-Outdoor-Pro/<Cmd>.json`, each holding **one reply entry** `{cmd, code, [initial], [range], value|error}`. This differs from the `{contentType, reply:[…]}` files of cx820, because the probe did not keep the HTTP content type; the README says so. Also `reference/E1-Outdoor-Pro/ptz-exchanges.json` (renamed from `_measured-ptz-exchanges.json`), an array of `{cmd, param, res, ms}`. Tasks 3 and 5 read these files.

- [ ] **Step 1: Write the failing test** `test/reference-privacy.test.ts`. It walks every file under `reference/` (all models, the Baichuan and ONVIF text too) and asserts:

```ts
expect(text).not.toMatch(/(?<![\w.])(?!192\.0\.2\.)(\d{1,3}\.){3}\d{1,3}(?![\w.])/); // IPv4 outside 192.0.2.0/24
expect(text).not.toMatch(/\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/);             // MAC
expect(text).not.toMatch(/\b9527\d{4}[A-Z0-9]{6,}\b/);                              // Reolink UID
expect(text).not.toMatch(/Backyard/);                                                // real camera names
// every "serial" value is SIM000000000000 or <redacted>
```

It also asserts that `reference/E1-Outdoor-Pro/` exists and holds the files listed in Step 3.

- [ ] **Step 2: Run** `npx vitest run test/reference-privacy.test.ts`. Expected: FAIL (no e1 folder). The existing folders must pass the pattern checks; if one doesn't, fix the regex for that false positive, not the data.

- [ ] **Step 3: Copy from `/Volumes/SSD-WDBlack-1T/claude-work/e1-reference/`.**

Files to copy:
- `GetAbility`, `GetDevInfo`, `GetEnc`, `GetAiState`, `GetIrLights`, `GetWhiteLed`, `GetIsp`, `GetMdAlarm`, `GetOsd`
- `GetPtzPreset`, `GetZoomFocus`, `GetPtzGuard`, `GetPtzCheckState`, `GetAutoFocus`, `GetPtzPatrol`, `GetPtzCurPos`, `GetPtzTattern`, `GetPtzSerial`, `GetPtzTraceSection`
- `_measured-ptz-exchanges.json` → `ptz-exchanges.json`

Then sanitize:
- DevInfo `serial` → `SIM000000000000`.
- DevInfo `name` and Osd `osdChannel.name` (the real name) → `Cam`.
- Keep `<redacted>` for `imgName`.

Re-check each copied file by eye and with the test for serials, MACs, IPs, UIDs, tokens and names. Leave out everything not listed: Wifi, LocalLink, RtspUrl, Email, Ftp, Push, Channelstatus and Certificate are not modelled, and several of them carry redactions.

Write `README.md` in the shape of `reference/cx820/README.md`:
- **Source:** E1 Outdoor Pro, firmware v3.1.0.5714_2511271366, 2026-10-30, read-only probe plus the PTZ measurement with Klaus's OK.
- **Files:** the list above, with the one-entry format.
- **Redacted:** what was replaced.
- **Differences from the CX820:** DevInfo `exactType WIFI_SOLO_IPC`, `wifi 1`, itemNo `E560`; Enc main 3840×2160 at 20 fps, 4096 kbps, audio 1; MdAlarm grid 60×33; Isp with `bd_night`, `CBR`, day/night Auto; IrLights range Auto/Off; WhiteLed mode 1, bright 85.
- **Measured PTZ:** §3's list.
- **Not measured, simulator's choice:** the "PTZ decisions" list from Task 2.

- [ ] **Step 4: Run** `npx vitest run test/reference-privacy.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** with `git add reference/E1-Outdoor-Pro test/reference-privacy.test.ts` and the message `test: E1 Outdoor Pro reference captures and a privacy check`.

---

### Task 2: The virtual PTZ state (`Ptz`)

**Files:**
- Create: `src/engine/ptz.ts`
- Test: `test/ptz.test.ts`

**Interfaces:**
- Consumes: `Clock` and `fixedClock` from `src/engine/clock.ts`.
- Produces (exported from `src/engine/ptz.ts`):

```ts
export const PTZ_OPS = ['Left','Right','Up','Down','LeftUp','LeftDown','RightUp','RightDown','Stop','ZoomInc','ZoomDec','FocusInc','FocusDec','ToPos'] as const;
type Range = readonly [number, number];
type Answer = { initial?: unknown; range?: unknown; value: unknown };
export interface PtzSpec {
  pan: Range; tilt: Range; zoom: Range; focus: Range;          // sim units: pan/tilt degrees
  start: { pan: number; tilt: number; zoom: number; focus: number };
  slots: number; nameMax: number; speed: Range; defaultSpeed: number;
  rate: { panTilt: number; zoom: number; focus: number };        // units per second per speed unit
  answers: { GetPtzGuard: Answer; GetPtzCheckState: Answer; GetAutoFocus: Answer; GetPtzPatrol: Answer };
  zoomFocusRange: unknown; presetRange: unknown;                 // GetZoomFocus / GetPtzPreset `range`
  refusals: Record<string, { rspCode: number; detail: string }>; // GetPtzCurPos, GetPtzTattern, …
}
export interface PtzPos { pan: number; tilt: number; zoom: number; focus: number }
export interface PtzView extends PtzPos {
  moving: { op: string; speed: number; since: string } | null;   // since: ISO time
  presets: Array<{ id: number; name: string; pan: number; tilt: number; zoom: number }>; // enabled only, by id
}
export interface PresetEntry { channel: 0; enable: 0 | 1; id: number; imgName: string; name: string }
export function ptzEnabled(ability: unknown): boolean;           // Ability.abilityChn[0].ptzCtrl.permit > 0
export class Ptz {
  constructor(spec: PtzSpec, clock: Clock);
  position(): PtzPos;                                            // at clock.now(); pan/tilt 0.1, zoom/focus integers
  control(p: { op?: unknown; speed?: unknown; id?: unknown }): number | null;   // null = 200, else rspCode
  zoomFocus(p: { op?: unknown; pos?: unknown }): number | null;
  setPreset(p: { id?: unknown; enable?: unknown; name?: unknown }): number | null;
  presets(): PresetEntry[];                                      // all slots, id 0..slots-1
  factoryPresets(): PresetEntry[];                               // for `initial`
  stop(): void;                                                  // settle and end any move
  reset(): void;                                                 // start position, all slots empty
  view(): PtzView;
}
```

**PTZ decisions** (not measured; the README from Task 1 lists them):
- pan 0–355 and tilt 0–50, starting at pan 180, tilt 25.
- Rates per speed unit: pan/tilt 1.5°/s, zoom 0.4 steps/s, focus 0.4 steps/s. Speed 32 ZoomInc for 1.5 s takes zoom 7 → 26, as measured.
- Left/Right change pan, Up/Down change tilt, the diagonals change both at full rate.
- A move lasts until `Stop`, another op or `ToPos`, and is clamped at the limits. `moving` stays set while the move is held at a limit.
- `ToPos` and `ZoomPos` apply at once.
- Omitted speed means 32. A speed that is not an integer → `-4`. `Stop` ignores speed.
- Presets store pan/tilt/zoom; focus is not stored or restored (the real camera refocuses).
- `enable: 0` resets the slot's name to `pos<id+1>`. `enable: 1` with an empty or non-string name keeps the slot's name.
- `StartZoomFocus` also takes `FocusPos`. Any other op, or a pos out of range → `-4`.

- [ ] **Step 1: Write the failing tests** in `test/ptz.test.ts`, using `fixedClock(new Date('2026-10-30T12:00:00Z'))` and a `SPEC` literal with the values above:

```ts
it('Left at speed 32 for 2 s: pan 180 → 84; Stop freezes it', ...)       // expect(p.position().pan).toBe(84)
it('ZoomInc 32 for 1.5 s: zoom 7 → 26 (measured)', ...)
it('clamps at the end stops and stays finite (review focus 1)', ...)        // Left 64 for 60 s → pan 0; ZoomInc 600 s → 27
it('a new op while moving settles the old one first (review focus 2)', ...) // Left 1 s then Up 1 s → pan 132, tilt 50 (clamped)
it('speed: omitted ok; 1 and 64 ok; 0, 65, 100, 1.5, "32" → -4', ...)
it('unknown op or missing op → -4; Stop always ok', ...)
it('SetPtzPreset stores pan/tilt/zoom; ToPos goes there and ends a move', ...)
it('ToPos to an empty slot → null and nothing changes (measured)', ...)
it('ids: 0..63 ok; 64, -1, "1", missing → -4 for SetPtzPreset and ToPos', ...)
it('a 40-character name is stored as pos63 for id 62 (measured)', ...)
it('enable 0 empties the slot; enable 2 → -4', ...)
it('ZoomPos 7 sets zoom 7; ZoomPos 28 and op "Bogus" → -4', ...)
it('presets() lists 64 entries id 0..63 named pos1..pos64, imgName ""', ...)
it('view(): moving {op, speed, since ISO} while moving, null after Stop; presets only enabled', ...)
it('reset() back to start, all slots empty', ...)
it('ptzEnabled: permit 7 → true; permit 0 or missing → false', ...)
```

- [ ] **Step 2: Run** `npx vitest run test/ptz.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/engine/ptz.ts`.** The state is `{ base: PtzPos, moving?: { op, speed, sinceMs } }`, and `position()` = clamp(base + direction × rate × speed × elapsed s). Every mutating call first settles the current move into `base` at `clock.now()`. Keep no state at module level (review focus 5).

- [ ] **Step 4: Run** `npx vitest run test/ptz.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** with `git add src/engine/ptz.ts test/ptz.test.ts` and the message `feat: virtual PTZ state for pan/tilt cameras`.

---

### Task 3: The `E1-Outdoor-Pro` profile

**Files:**
- Create: `src/profile/E1-Outdoor-Pro.ts`, `src/profile/e1-ability.json` (the `value` of `reference/E1-Outdoor-Pro/GetAbility.json`), `src/profile/e1-ptz.json` (the PTZ Get answers without `cmd`/`code`, with `imgName` `""`)
- Modify: `src/profile/profile.ts` (`MODELS`, `PROFILES`, `CameraProfile.ptz?`, `extras.IrLights`)
- Modify: `src/profile/rlc1224a.ts:24` (`devInfoFor` takes overrides)
- Modify: `README.md` (Configuration table rows for `CAMSIM_MODEL`, `CAMSIM_FIRMWARE`, `CAMSIM_MAIN_SIZE`; a third entry under "Camera models"), `CHANGELOG.md` (Unreleased), `llms.txt` if it lists models
- Test: `test/profile-e1.test.ts`; update the `MODELS` assertion in `test/profile-cx820.test.ts:38`

**Interfaces:**
- Consumes: `PtzSpec` from Task 2; `reference/E1-Outdoor-Pro/*.json` from Task 1.
- Produces:
  - `MODELS = ['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const`.
  - `CameraProfile.ptz?: PtzSpec`: set exactly when `ptzEnabled(profile.ability)`.
  - `E1_OUTDOOR_PRO: CameraProfile` exported from `src/profile/E1-Outdoor-Pro.ts`.
  - `devInfoFor(f, itemNo, over?: { exactType?: string; wifi?: number })`.
  - How another repo selects the model: `CAMSIM_MODEL=E1-Outdoor-Pro` (CLI or container), or `createCamSim({ users, model: 'E1-Outdoor-Pro' })` in process (`Model` and `MODELS` are already exported from the package root).

- [ ] **Step 1: Write the failing tests** in `test/profile-e1.test.ts`. They compare against `reference/E1-Outdoor-Pro/` and use a `shape()` like profile-cx820's:

```ts
expect(MODELS).toEqual(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro']);
expect(loadConfig({ ...base, CAMSIM_MODEL: 'E1-Outdoor-Pro' })).toMatchObject({ model: 'E1-Outdoor-Pro', firmVer: 'v3.1.0.5714_2511271366', mainSize: '3840x2160' });
expect(() => loadConfig({ ...base, CAMSIM_MODEL: 'E1-OUTDOOR-PRO' })).toThrow(ConfigError);
expect(configFromOptions({ users: [], model: 'E1-Outdoor-Pro' }).model).toBe('E1-Outdoor-Pro');
// DevInfo minus `simulator` equals the reference (serial SIM000000000000, name Cam): model 'E1 Outdoor Pro', exactType 'WIFI_SOLO_IPC', wifi 1, itemNo 'E560'
expect(E1.enc).toEqual(ref('GetEnc').Enc);
expect(E1.ability).toEqual(ref('GetAbility'));
expect(E1.media).toEqual({ sub: '640x360', subFps: 10, mainFps: 20, mainSize: '3840x2160' });
// GetIrLights / GetWhiteLed extras equal the captures' initial/range
// factory Isp, WhiteLed and Osd (name aside) have the captures' key sets; MdAlarm scope 60 x 33
expect(E1.ptz).toMatchObject({ zoom: [0, 27], focus: [0, 97], slots: 64, nameMax: 31, speed: [1, 64], start: { zoom: 7, focus: 49 } });
for (const m of MODELS) expect(!!profileFor(m).ptz).toBe(ptzEnabled(profileFor(m).ability));
expect(fixtureSpec(E1).suffix).toBe('-E1-Outdoor-Pro');
```

- [ ] **Step 2: Run** `npx vitest run test/profile-e1.test.ts test/profile-cx820.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the profile**, following `cx820.ts`.

From the captures: firmware (`model 'E1 Outdoor Pro'`, firmVer `v3.1.0.5714_2511271366`, hardVer `IPC_560SD88MPW`, buildDay `build 2511271366`, cfgVer `v3.1.0.0`, detail `IPC_560SD88MPWS38A9T460E1W13110`), the DevInfo overrides, Enc, ability, the IrLights and WhiteLed extras, and the factory Isp, WhiteLed, Osd keys and MdAlarm grid 60×33.

Everything else comes from the CX820 profile, `(not measured)`: the AiAlarm grid (also 60×33), GetUser, the FTP masks, `whiteLedModes`, `fileFlags`, and the Baichuan auth types, login reply and pushes. List these in the profile's header comment and in the reference README.

`ptz`: Task 2's PTZ decisions, plus `answers`, `zoomFocusRange`, `presetRange` and `refusals` from `e1-ptz.json`:
- `GetPtzCurPos` -1 "not exist"
- `GetPtzTraceSection` -1 "not exist"
- `GetPtzTattern` -12 "get config failed"
- `GetPtzSerial` -12 "get config failed"

- [ ] **Step 4: Run** `npm test` (the global setup builds the new fixture folder) and `npm run lint:types`. Expected: PASS.

- [ ] **Step 5: Update the docs.** In the README, add an `E1-Outdoor-Pro` entry under "Camera models" with the differences from Task 1's README and a pointer to "PTZ" (Task 4), and the model in the three Configuration rows. In the CHANGELOG, add an Unreleased entry: a third camera model, `CAMSIM_MODEL=E1-Outdoor-Pro` (in process `createCamSim({ model: 'E1-Outdoor-Pro' })`), from captures of the real E1 (firmware v3.1.0.5714); the default stays RLC-1224A, unchanged. Later tasks add to this entry.

- [ ] **Step 6: Commit** with `git add src/profile test/profile-e1.test.ts test/profile-cx820.test.ts README.md CHANGELOG.md` (plus `llms.txt` if changed) and the message `feat: E1 Outdoor Pro camera profile`.

---

### Task 4: PTZ commands on the camera API

**Files:**
- Create: `src/camera-api/ptz-commands.ts`
- Modify: `src/camera-api/commands.ts:13-24` (`DETAIL` gains `[-1]: 'not exist'`, `[-12]: 'get config failed'`), `:204` `runCommand`
- Modify: `src/engine/engine.ts` (`readonly ptz: Ptz | null`; `reset()` gains `ptz?: boolean`; `boot()` calls `this.ptz?.stop()`)
- Modify: `README.md` (a "PTZ (pan/tilt models)" subsection under Simulated camera API, and the fault table rows for `settings.fail` / `settings.ignore`: "also `SetPtzPreset`"), `CHANGELOG.md`
- Test: `test/conformance/ptz-api.test.ts`

**Interfaces:**
- Consumes: `Ptz`, `ptzEnabled` (Task 2); `profile.ptz` (Task 3); `ok`, `fail`, `Ctx`, `Entry` from `commands.ts`.
- Produces:
  - `engine.ptz: Ptz | null`, used by Tasks 6 and 7.
  - `engine.reset({ ptz: true })`.
  - `PTZ_HANDLERS: Record<string, Handler>` in `ptz-commands.ts`, for `PtzCtrl`, `StartZoomFocus`, `GetZoomFocus`, `GetPtzPreset`, `SetPtzPreset`, `GetPtzGuard`, `GetPtzCheckState`, `GetAutoFocus`, `GetPtzPatrol`, plus one refusal handler per `profile.ptz.refusals` key.
  - `runCommand` dispatches to `PTZ_HANDLERS` first, but only when `c.engine.ptz` is set.

- [ ] **Step 1: Write the failing tests** in `test/conformance/ptz-api.test.ts`, using `makeCamera({ CAMSIM_MODEL: 'E1-Outdoor-Pro' }, { clock })`, `login`, and `post`:

```ts
it('PtzCtrl Left 32, 2 s, Stop → {rspCode:200}; GET state pan 84', ...)          // via engine.ptz.view()
it('PtzCtrl speed 0 → {cmd:"PtzCtrl",code:1,error:{detail:"param error",rspCode:-4}}', ...)
it('GetZoomFocus: {initial, range, value} with value.ZoomFocus {channel:0, focus:{pos:49}, zoom:{pos:7}}', ...)
it('SetPtzPreset id 63 then GetPtzPreset shows enable 1 and the name; ToPos 63 restores zoom', ...)
it('StartZoomFocus ZoomPos 7 → 200; GetZoomFocus zoom 7', ...)
it('GetPtzGuard / GetPtzCheckState / GetAutoFocus / GetPtzPatrol answer the profile values', ...)
it('GetPtzCurPos → {cmd:"GetPtzCurPos",code:1,error:{detail:"not exist",rspCode:-1}}', ...)
it('settings.fail / settings.ignore with cmds ["SetPtzPreset"] apply; counters.setCalls lists SetPtzPreset', ...)
it.each(['RLC-1224A','CX820'])('%s: every PTZ command answers the old Unknown -9 and engine.ptz is null (review focus 4)', ...)
it('reboot mid-move stops the move and keeps presets; reset({ptz:true}) clears both (review focus 3)', ...)
it('two E1 engines move independently (review focus 5)', ...)
```

- [ ] **Step 2: Run** `npx vitest run test/conformance/ptz-api.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the engine part.** `ptz = ptzEnabled(profile.ability) ? new Ptz(profile.ptz!, clock) : null`; throw at construction if `profile.ptz` is missing. `reset()`: `if (all || what.ptz) this.ptz?.reset()`. `boot()` (reboot and power-on): `this.ptz?.stop()`.

- [ ] **Step 4: Implement the handlers.**
  - Get answers use `ok(cmd, value, { initial, range })`, so the key order is `cmd, code, initial, range, value` as captured. They answer with initial/range regardless of `action`, as captured (`(not measured)` for action 0).
  - `SetPtzPreset` goes through `counters.noteSet`, `faults.consume('settings.fail', cmd)` and `faults.consume('settings.ignore', cmd)` like `setCommand`, then `ptz.setPreset(param.PtzPreset)`. It emits no `settings` bus event.
  - `PtzCtrl` takes `param` (`op`, `speed`, `id`). `StartZoomFocus` takes `param.ZoomFocus`.

- [ ] **Step 5: Run** `npm test` and `npm run lint:types`. Expected: PASS.

- [ ] **Step 6: Update the docs.** In the README, add the PTZ command list with the measured rules and the simulator's own choices (Task 2), and the fault-table rows. In the CHANGELOG, extend the entry with the PTZ commands, and note that `settings.fail`/`settings.ignore` now also cover `SetPtzPreset`.

- [ ] **Step 7: Commit** with `git add src/camera-api src/engine/engine.ts test/conformance/ptz-api.test.ts README.md CHANGELOG.md` and the message `feat: PTZ commands for pan/tilt models`.

---

### Task 5: Conformance against the real E1's answers

**Files:**
- Test: `test/conformance/ptz-reference.test.ts`

**Interfaces:**
- Consumes: `reference/E1-Outdoor-Pro/ptz-exchanges.json` and the PTZ `Get*.json` files (Task 1); the E1 camera from Task 4.

- [ ] **Step 1: Write the test.**
  - **Replay `ptz-exchanges.json` in order** against one E1 sim with a `fixedClock`. Before the `Stop` that follows `ZoomInc`, advance 1500 ms; advance 100 ms between the other pairs. For each exchange:
    - non-Get commands: `expect(reply).toEqual(ex.res)`;
    - `GetZoomFocus`: `expect(reply.range).toEqual(ex.res.range)`, the same key shape, and the zoom/focus values within range.
    - Then assert that the reply after the `ZoomInc` exchange has zoom 26.
  - **The Get files:** for each PTZ `Get*.json`, `shape(reply)` equals `shape(file)`, and `reply.range` equals `file.range`. Refusals are equal in full (`GetPtzCurPos`, `GetPtzTattern`, `GetPtzSerial`, `GetPtzTraceSection`). `GetPtzPreset.value.PtzPreset` names equal the file's, `pos1`…`pos64`.

- [ ] **Step 2: Run** `npx vitest run test/conformance/ptz-reference.test.ts`. Expected: PASS if Tasks 2–4 match the camera. On a failure, fix the simulator, never the capture. If the mismatch is a decision from Task 2 contradicted by a capture, change the decision and its README line.

- [ ] **Step 3: Commit** with `git add test/conformance/ptz-reference.test.ts` (plus any fixes) and the message `test: PTZ conformance against the E1 captures`.

---

### Task 6: Control API `GET /sim/api/ptz` and reset

**Files:**
- Modify: `src/control-api/app.ts` (the new route, and `pick('ptz')` in `/reset` at :208)
- Modify: `openapi.yaml` (the `/sim/api/ptz` path with its `PtzView` schema; `ptz: { type: boolean }` in the reset body)
- Modify: `src/index.ts` (`export type { PtzView } from './engine/ptz'`)
- Modify: `README.md` (control API list), `CHANGELOG.md`
- Test: `test/control-api.test.ts`; `test/openapi.test.ts` stays as is and must pass

**Interfaces:**
- Consumes: `engine.ptz.view()` (Task 2/4), `engine.reset({ ptz })` (Task 4).
- Produces:
  - `GET /sim/api/ptz` (control token as for the other `/sim/api` routes): 200 `PtzView` = `{pan, tilt, zoom, focus, moving: {op, speed, since}|null, presets: [{id, name, pan, tilt, zoom}]}`. A model without PTZ gets 404 `{"error":"no_ptz"}`.
  - `POST /sim/api/reset` with `{ptz: true}`, or an empty body, clears the PTZ state.
  - For other repos, the package root exports the type `PtzView`. In process, `sim.engine.ptz?.view()` gives the same object.

- [ ] **Step 1: Write the failing tests** in `test/control-api.test.ts`:

```ts
it('GET /sim/api/ptz on an E1: start state, then a preset and a move show up', ...)  // {pan:180,tilt:25,zoom:7,focus:49,moving:null,presets:[]}
it('GET /sim/api/ptz on the RLC-1224A → 404 {error:"no_ptz"} (review focus 4)', ...)
it('POST /sim/api/reset {} and {ptz:true} clear presets and position; {settings:true} alone keeps them', ...)
```

- [ ] **Step 2: Run** `npx vitest run test/control-api.test.ts test/openapi.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the route, the reset flag, the openapi entries and the type export.

- [ ] **Step 4: Run** `npm test` and `npm run lint:types`. Expected: PASS (openapi.test.ts too).

- [ ] **Step 5: Commit** with `git add src/control-api/app.ts src/index.ts openapi.yaml test/control-api.test.ts README.md CHANGELOG.md` and the message `feat: control API for the PTZ state`.

---

### Task 7: The position on the picture

**Files:**
- Modify: `src/pipeline/overlay.ts` (`ptzText`; `filterChain` takes an optional `files.ptz`)
- Modify: `src/pipeline/sd-pipeline.ts` (`files()` gains `ptz` when `engine.ptz`; `writeClock()` also writes the PTZ text)
- Create: `src/pipeline/ptz-picture.ts`
- Modify: `src/engine/engine.ts` (`snapshot(): Promise<Buffer>`), `src/camera-api/media-routes.ts:89` and `src/control-api/app.ts:217` (use `engine.snapshot()`)
- Modify: `README.md` (Snapshots, SD pipeline), `CHANGELOG.md`
- Test: `test/overlay.test.ts`, `test/sd-pipeline.test.ts`, `test/ptz-picture.test.ts`

**Interfaces:**
- Consumes: `engine.ptz.position()` (Task 2/4); `findFonts(config.fontDir)`.
- Produces:
  - `ptzText(p: { pan: number; tilt: number; zoom: number }): string` returns `PAN ${round(pan)} TILT ${round(tilt)} ZOOM ${zoom}`, e.g. `PAN 180 TILT 25 ZOOM 7`.
  - `filterChain(s, files: { clock: string; name: string; ptz?: string }, fonts)`: with `ptz` it appends `drawtext=fontfile=…:textfile=<ptz>:reload=1:expansion=none:fontsize=20:fontcolor=white:borderw=2:bordercolor=black@0.6:x=(w-text_w)/2:y=(h-text_h)/2`, centered, so it can't collide with the six OSD positions.
  - `drawTextOnJpeg(jpeg: Buffer, text: string, font: string, ffmpeg?: string): Promise<Buffer>`: one ffmpeg run with image2pipe in and mjpeg out, the same drawtext style.
  - `Engine.snapshot()`:
    - without `ptz`, or without a font, it returns `media.snapshot()` unchanged;
    - otherwise it returns the overlaid JPEG, cached in one entry keyed by `${videoId}|${text}`;
    - if ffmpeg fails it logs `ptz_snapshot_failed` once and returns the plain JPEG.
  - The FTP uploader keeps `media.snapshot()` (unchanged; `(not measured)` whether the camera's FTP picture shows anything extra).

- [ ] **Step 1: Write the failing tests:**

```ts
// overlay.test.ts
expect(ptzText({ pan: 179.6, tilt: 25.04, zoom: 7 })).toBe('PAN 180 TILT 25 ZOOM 7');
expect(filterChain(s, { clock, name }, fonts)).toBe(<today's output for the same input>);   // review focus 4
expect(filterChain(s, { clock, name, ptz: '/t/ptz.txt' }, fonts)).toMatch(/textfile=\/t\/ptz\.txt.*x=\(w-text_w\)\/2:y=\(h-text_h\)\/2$/);
// ptz-picture.test.ts (skip without fonts, like the overlay ffmpeg tests)
it('E1 snapshot differs from the fixture and changes after a move; same state → cached (one ffmpeg run)', ...)
it('RLC-1224A snapshot is the fixture byte for byte (review focus 4)', ...)
it('a failing ffmpeg (ffmpeg path "/nonexistent") falls back to the fixture JPEG, no throw', ...)
// sd-pipeline.test.ts
it('an E1 pipeline writes the PTZ text next to the clock each tick', ...)   // read pipeline['files']().ptz after a tick
```

- [ ] **Step 2: Run** `npx vitest run test/overlay.test.ts test/ptz-picture.test.ts test/sd-pipeline.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the overlay, pipeline, picture and engine changes as in the Interfaces block. The text holds only `[A-Z0-9 .-]`; the font path goes through the existing `q()` escaping.

- [ ] **Step 4: Run** `npm test` and `npm run lint:types`. Expected: PASS.

- [ ] **Step 5: Check by hand.** Run `CAMSIM_MODEL=E1-Outdoor-Pro npm run dev` and open the web UI's snapshot. It shows `PAN 180 TILT 25 ZOOM 7` in the middle. Don't commit the picture.

- [ ] **Step 6: Update the docs.** In the README: "PTZ models draw `PAN x TILT y ZOOM z` on snapshots and, while the SD pipeline is on, on live SD". In the CHANGELOG, extend the entry.

- [ ] **Step 7: Commit** with `git add src/pipeline src/engine/engine.ts src/camera-api/media-routes.ts src/control-api/app.ts test/overlay.test.ts test/ptz-picture.test.ts test/sd-pipeline.test.ts README.md CHANGELOG.md` and the message `feat: the PTZ position on snapshots and live SD`.

---

## After the plan

- Run `npm run test:e2e` once: the web UI is untouched, but the model name shows in the top bar.
- Open the PR to `main`. The release follows the usual flow. cam-proxy plan B needs that release, plus a cam-sim tarball bump in cam-proxy's `package.json`, before its integration tests can use `model: 'E1-Outdoor-Pro'`.
